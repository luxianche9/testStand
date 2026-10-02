"""Deploy, upgrade and uninstall one service on a Windows computer (design doc 4.8.3).

Every guarantee of the old ``deploy.ps1`` is kept and none of the steps may be skipped:
upload to staging, SHA-256 verification, backup, safe stop, replace, ``install.ps1``, the
remote ``--check``, ``start.ps1``, ``/health`` and the caller's ``/device`` check. A failure
after the files were replaced restores the backup and restarts the old version.

The token is generated here once, written only to the remote ``server.json`` (over the
file channel, never a command line) and handed back inside :class:`DeployOutcome` for the
keyring; it is never part of a step log or a public result.
"""

from __future__ import annotations

import datetime
import functools
import json
import re
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, TypeVar

from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.devices.lifecycle import ps_quote
from hardwareharness_backend.devices.service_registry import read_token_script

from .bundle import Bundle

Record = dict[str, Any]
T = TypeVar("T")
StopOld = Callable[[], Awaitable[Any]]
VerifyDevice = Callable[[str, int], Awaitable[Any]]
Progress = Callable[[Record], None]

ARCHIVE_DIR = r"C:\ProgramData\HardwareHarness\backup"
KEPT = (
    "server.json", "venv", ".venv", "logs", "run", "backup", ".env", "secrets*", "credentials*",
    "native", "app",
)  # fmt: skip
"""Root entries a deploy never replaces, backs up or deletes (plus the staging directories).

``native`` and ``app`` hold the vendor CLIs compiled on the remote computer (``hwcli_*.exe``
under ``native\\build\\``, or ``app\\native\\build\\`` in older installs); bundles never carry them.
"""
_ROOT = re.compile(r"^[A-Za-z]:\\(?:[^\\/:*?\"<>|]+\\)*[^\\/:*?\"<>|]+$")


class RemoteHost(Protocol):
    """One PowerShell computer: scripts run with ``-EncodedCommand``, files go over SFTP."""

    async def run(self, script: str, timeout_ms: int) -> Record: ...
    async def upload(self, local: Path, remote: str) -> None: ...
    async def write_file(self, remote: str, data: bytes) -> None: ...


@dataclass(frozen=True)
class DeploySpec:
    server_id: str
    hardware_id: str
    root: str
    port: int
    computer_id: str
    settings: Record = field(default_factory=dict)
    dry_run: bool = False
    autostart: bool = True


@dataclass
class DeployOutcome:
    root: str
    port: int
    created_config: bool
    upgraded: bool
    steps: list[Record]
    build: Record
    token: str = field(repr=False)

    def public(self) -> Record:
        """What callers may see and log: everything but the token."""
        return {
            "root": self.root,
            "port": self.port,
            "createdConfig": self.created_config,
            "upgraded": self.upgraded,
            "steps": self.steps,
            "build": {
                key: self.build.get(key)
                for key in ("adapter", "adapterModule", "sdkVersion", "sourceRevision", "builtAt")
            },
        }


def validate_root(root: str) -> str:
    value = root.strip().rstrip("\\/")
    if not _ROOT.match(value) or any(part in {".", ".."} for part in value.split("\\")):
        raise app_error("invalid_argument", f"Not a service root directory: {root!r}")
    return value


def default_root(server_id: str) -> str:
    return f"E:\\{server_id.lower()}_server"


class _Steps:
    def __init__(self, progress: Progress | None) -> None:
        self.items: list[Record] = []
        self.progress = progress

    async def run(self, name: str, action: Callable[[], Awaitable[T]]) -> T:
        if self.progress:
            self.progress({"step": name, "state": "running"})
        try:
            result = await action()
        except Exception as error:
            self._record({"step": name, "ok": False, "message": str(error)})
            raise
        self._record({"step": name, "ok": True})
        return result

    def skip(self, name: str, reason: str) -> None:
        self._record({"step": name, "ok": True, "skipped": reason})

    def _record(self, item: Record) -> None:
        self.items.append(item)
        if self.progress:
            self.progress(item)

    @property
    def failed(self) -> str:
        return next((item["step"] for item in self.items if not item["ok"]), "?")


async def _run(host: RemoteHost, script: str, what: str, timeout_ms: int = 120000) -> str:
    result = await host.run(script, timeout_ms)
    if result.get("exitCode") != 0:
        detail = (result.get("stderr") or result.get("stdout") or "").strip()[-1500:]
        raise app_error("error", f"{what} failed (exit {result.get('exitCode')}): {detail}")
    return str(result.get("stdout") or "")


def _last_json(stdout: str, what: str) -> Any:
    for line in reversed(stdout.strip().splitlines()):
        if line.strip().startswith(("{", "[")):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                break
    raise app_error("invalid_response", f"{what} printed no JSON result")


def _keep_function() -> str:
    patterns = ", ".join(ps_quote(item) for item in (*KEPT, "deploy-staging-*"))
    return (
        f"$kept = @({patterns})\n"
        "function Test-Kept([string]$name) { foreach ($p in $kept) { if ($name -like $p) "
        "{ return $true } }; return $false }\n"
    )


def _inspect_script(root: str) -> str:
    return (
        f"$root = {ps_quote(root)}\n"
        "New-Item -ItemType Directory -Force -Path $root | Out-Null\n"
        "$configPath = Join-Path $root 'server.json'\n"
        "$config = $null\n"
        "if (Test-Path -LiteralPath $configPath) { $config = Get-Content -Raw -LiteralPath "
        "$configPath | ConvertFrom-Json }\n"
        "$state = 'Absent'\n"
        "if ($config -and (Test-Path -LiteralPath (Join-Path $root 'status.ps1'))) {\n"
        "  try { $state = [string]((& (Join-Path $root 'status.ps1') | Select-Object -Last 1) "
        "| ConvertFrom-Json).state } catch { $state = 'Unknown' }\n"
        "}\n"
        "[pscustomobject]@{ hasConfig = [bool]$config; "
        "serverId = $(if ($config) { [string]$config.serverId } else { $null }); "
        "port = $(if ($config -and $config.port) { [int]$config.port } else { 0 }); "
        "hasBuild = (Test-Path -LiteralPath (Join-Path $root 'build.json')); "
        "hasUninstall = (Test-Path -LiteralPath (Join-Path $root 'uninstall.ps1')); "
        "state = $state } | ConvertTo-Json -Compress\n"
    )


async def _inspect(host: RemoteHost, root: str) -> Record:
    state = _last_json(await _run(host, _inspect_script(root), "Inspecting " + root), "inspect")
    if not isinstance(state, dict):
        raise app_error("invalid_response", "inspect printed no object")
    return state


def _is_running(state: Record) -> bool:
    return state.get("state") not in {"Stopped", "Absent"}


async def _read_token(host: RemoteHost, root: str) -> str:
    token = (await _run(host, read_token_script(root), "Reading server.json", 15000)).strip()
    if not token:
        raise app_error("not_found", f"{root}\\server.json has no token")
    return token


async def _upload(host: RemoteHost, bundle: Bundle, staging: str) -> None:
    folders = {staging} | {
        staging + "\\" + "\\".join(item.relative.split("/")[:-1])
        for item in bundle.files
        if "/" in item.relative
    }
    paths = ", ".join(ps_quote(item) for item in sorted(folders))
    await _run(host, f"New-Item -ItemType Directory -Force -Path @({paths}) | Out-Null", "mkdir")
    for item in bundle.files:
        await host.upload(item.path, staging + "\\" + item.relative.replace("/", "\\"))


async def _verify(host: RemoteHost, bundle: Bundle, staging: str) -> None:
    script = (
        f"$staging = {ps_quote(staging)}\n"
        "$items = @(Get-ChildItem -LiteralPath $staging -Recurse -File | ForEach-Object { "
        "[pscustomobject]@{ path = $_.FullName.Substring($staging.Length + 1); "
        "sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash } })\n"
        "ConvertTo-Json -InputObject $items -Compress\n"
    )
    listed = _last_json(await _run(host, script, "Hashing staging", 300000), "hash")
    actual = {str(item["path"]).lower(): str(item["sha256"]).lower() for item in listed}
    expected = {item.relative.replace("/", "\\").lower(): item.sha256 for item in bundle.files}
    wrong = sorted(
        path for path in expected.keys() | actual.keys() if expected.get(path) != actual.get(path)
    )
    if wrong:
        raise app_error(
            "invalid_response",
            f"SHA-256 mismatch after upload: {', '.join(wrong[:5])}"
            + (f" and {len(wrong) - 5} more" if len(wrong) > 5 else ""),
        )


def server_config(spec: DeploySpec, port: int, token: str, build: Record) -> bytes:
    """The remote ``server.json`` (design doc 4.7); written once, reused by every upgrade."""
    document = {
        "serverId": spec.server_id,
        "hardwareId": spec.hardware_id,
        "manufacturer": build["manufacturer"],
        "model": build["model"],
        "host": "0.0.0.0",
        "port": port,
        "token": token,
        "computerId": spec.computer_id,
        "dryRun": spec.dry_run,
        "settings": spec.settings,
    }
    return (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _copy_script(root: str, source: str | None) -> str:
    """Remove every non-kept root entry, then copy ``source``'s entries in (if any)."""
    lines = [
        f"$root = {ps_quote(root)}",
        _keep_function(),
        "Get-ChildItem -LiteralPath $root -Force | Where-Object { -not (Test-Kept $_.Name) } "
        "| Remove-Item -Recurse -Force",
    ]
    if source:
        lines.append(
            f"Get-ChildItem -LiteralPath {ps_quote(source)} -Force | ForEach-Object "
            "{ Copy-Item -LiteralPath $_.FullName -Destination $root -Recurse -Force }"
        )
    return "\n".join(lines) + "\n"


def _backup_script(root: str, backup: str) -> str:
    return (
        f"$root = {ps_quote(root)}\n$backup = {ps_quote(backup)}\n"
        + _keep_function()
        + "New-Item -ItemType Directory -Force -Path $backup | Out-Null\n"
        "Get-ChildItem -LiteralPath $root -Force | Where-Object { -not (Test-Kept $_.Name) } "
        "| ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $backup -Recurse "
        "-Force }\n"
    )


def _script(root: str, name: str, arguments: str = "") -> str:
    return f"& (Join-Path {ps_quote(root)} {ps_quote(name)}) {arguments}".rstrip() + "\n"


def _install_script(root: str, autostart: bool) -> str:
    return _script(root, "install.ps1", f"-AutoStart:${str(autostart).lower()}")


def _check_script(root: str, module: str) -> str:
    return (
        f"& (Join-Path {ps_quote(root)} 'venv\\Scripts\\python.exe') -m hardwareharness_device_sdk "
        f"--adapter {ps_quote(module)} --check --log-level warning\nexit $LASTEXITCODE\n"
    )


def _health_script(port: int) -> str:
    # WebClient without a proxy: bench computers set HTTP_PROXY, which must not see loopback.
    return (
        "$client = New-Object System.Net.WebClient\n$client.Proxy = $null\n"
        "for ($i = 0; $i -lt 30; $i++) {\n"
        f"  try {{ $health = $client.DownloadString('http://127.0.0.1:{port}/health') "
        "| ConvertFrom-Json; if ($health.healthy) { $health | ConvertTo-Json -Compress; exit 0 } "
        "} catch {}\n"
        "  Start-Sleep -Seconds 1\n}\n"
        "Write-Error 'The service did not report healthy within 30 s'\nexit 1\n"
    )


async def _health(host: RemoteHost, port: int, server_id: str) -> None:
    health = _last_json(await _run(host, _health_script(port), "Polling /health", 60000), "health")
    if health.get("serverId") != server_id:
        raise app_error(
            "conflict", f"Port {port} answers as {health.get('serverId')!r}, not {server_id}"
        )


def _stamp() -> str:
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


async def deploy(
    host: RemoteHost,
    bundle: Bundle,
    spec: DeploySpec,
    *,
    stop_old: StopOld,
    verify_device: VerifyDevice | None = None,
    progress: Progress | None = None,
) -> DeployOutcome:
    """Install or upgrade ``bundle`` under ``spec.root``; an existing ``server.json`` wins."""
    root = validate_root(spec.root)
    if bundle.build.get("serverId") != spec.server_id:
        raise app_error(
            "invalid_argument", f"The bundle was built for {bundle.build.get('serverId')}"
        )
    steps = _Steps(progress)
    stamp = _stamp()
    staging, backup = f"{root}\\deploy-staging-{stamp}", f"{root}\\backup\\{stamp}"
    state = await steps.run("inspect", lambda: _inspect(host, root))
    if state["hasConfig"] and state.get("serverId") != spec.server_id:
        raise app_error(
            "conflict", f"{root} belongs to {state.get('serverId')!r}, not {spec.server_id}"
        )
    if state["hasConfig"]:
        token = await steps.run("config.read", lambda: _read_token(host, root))
        port = int(state.get("port") or spec.port)
    else:
        token, port = secrets.token_urlsafe(32), spec.port
    running = _is_running(state)
    try:
        await steps.run("upload", lambda: _upload(host, bundle, staging))
        await steps.run("verify", lambda: _verify(host, bundle, staging))
        if not state["hasConfig"]:
            config = server_config(spec, port, token, bundle.build)
            await steps.run("config.write", lambda: host.write_file(root + "\\server.json", config))
        has_backup = bool(state["hasBuild"])
        if has_backup:
            await steps.run(
                "backup", lambda: _run(host, _backup_script(root, backup), "Backup", 300000)
            )
        else:
            steps.skip("backup", "no previous version")
        if running:
            await steps.run("stop", stop_old)
        else:
            steps.skip("stop", "not running")
        try:
            await steps.run(
                "replace", lambda: _run(host, _copy_script(root, staging), "Replace", 300000)
            )
            await steps.run(
                "install",
                lambda: _run(host, _install_script(root, spec.autostart), "install.ps1", 600000),
            )
            module = str(bundle.build["adapterModule"])
            await steps.run(
                "check", lambda: _run(host, _check_script(root, module), "--check", 300000)
            )
            await steps.run("start", lambda: _run(host, _script(root, "start.ps1"), "start.ps1"))
            await steps.run("health", lambda: _health(host, port, spec.server_id))
            if verify_device:
                await steps.run("device", lambda: verify_device(token, port))
        except Exception as error:
            restored = await _rollback(
                host, root, backup if has_backup else None, running, spec.autostart, steps
            )
            raise app_error(
                "error",
                f"Deploying {spec.server_id} failed at {steps.failed}: {error}. "
                + (
                    "The previous version was restored."
                    if restored and has_backup
                    else "The new files were removed."
                    if restored
                    else "Rollback failed; check the computer before retrying."
                ),
                {"steps": steps.items, "rolledBack": restored},
            ) from error
    finally:
        try:
            await host.run(
                f"Remove-Item -LiteralPath {ps_quote(staging)} -Recurse -Force "
                "-ErrorAction SilentlyContinue",
                120000,
            )
        except Exception:
            steps.skip("cleanup", "staging could not be removed")
    return DeployOutcome(
        root=root,
        port=port,
        created_config=not state["hasConfig"],
        upgraded=bool(state["hasBuild"]),
        steps=steps.items,
        build=bundle.build,
        token=token,
    )


async def _rollback(
    host: RemoteHost,
    root: str,
    backup: str | None,
    restart: bool,
    autostart: bool,
    steps: _Steps,
) -> bool:
    stop = (
        f"if (Test-Path -LiteralPath (Join-Path {ps_quote(root)} 'stop.ps1')) "
        "{ " + _script(root, "stop.ps1").strip() + " }\n"
    )
    plan: list[tuple[str, str, int]] = [
        ("rollback.stop", stop, 120000),
        ("rollback.restore", _copy_script(root, backup), 300000),
    ]
    if backup:
        plan.append(("rollback.install", _install_script(root, autostart), 600000))
        if restart:
            plan.append(("rollback.start", _script(root, "start.ps1"), 120000))
    ok = True
    for name, script, timeout in plan:
        try:
            await steps.run(
                name,
                functools.partial(_run, host, script, name, timeout),
            )
        except Exception:
            ok = False
            if name != "rollback.stop":
                break
    return ok


async def uninstall(
    host: RemoteHost,
    root: str,
    server_id: str,
    *,
    stop_old: StopOld,
    uninstall_script: bytes | None = None,
    progress: Progress | None = None,
) -> Record:
    """Safe stop → ``uninstall.ps1`` → archive the directory → delete it."""
    root = validate_root(root)
    steps = _Steps(progress)
    state = await steps.run("inspect", lambda: _inspect(host, root))
    if not state["hasConfig"] and not state["hasBuild"]:
        raise app_error("not_found", f"{root} holds no installed service")
    if state["hasConfig"] and state.get("serverId") != server_id:
        raise app_error("conflict", f"{root} belongs to {state.get('serverId')!r}")
    if _is_running(state):
        await steps.run("stop", stop_old)
    else:
        steps.skip("stop", "not running")
    if not state.get("hasUninstall"):
        if uninstall_script is None:
            raise app_error("not_found", f"{root} has no uninstall.ps1; upgrade it first")
        script_bytes = uninstall_script
        await steps.run(
            "uninstall.write", lambda: host.write_file(root + "\\uninstall.ps1", script_bytes)
        )
    await steps.run("unregister", lambda: _run(host, _script(root, "uninstall.ps1"), "uninstall"))
    archive = f"{ARCHIVE_DIR}\\{server_id}-{_stamp()}.zip"
    await steps.run(
        "archive",
        lambda: _run(
            host,
            f"$root = {ps_quote(root)}\n"
            f"New-Item -ItemType Directory -Force -Path {ps_quote(ARCHIVE_DIR)} | Out-Null\n"
            "$items = @(Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -notin "
            "@('venv', '.venv') -and $_.Name -notlike 'deploy-staging-*' })\n"
            f"if ($items) {{ Compress-Archive -LiteralPath $items.FullName -DestinationPath "
            f"{ps_quote(archive)} -Force }}\n",
            "Archive",
            600000,
        ),
    )
    await steps.run(
        "remove",
        lambda: _run(
            host, f"Remove-Item -LiteralPath {ps_quote(root)} -Recurse -Force", "Remove", 300000
        ),
    )
    return {"root": root, "archive": archive, "steps": steps.items}
