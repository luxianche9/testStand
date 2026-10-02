"""Deploy, upgrade and uninstall from the terminal (design doc 4.8.3, B3/B4/R1)."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from hardwareharness_backend.application import HUMAN_REQUEST_CONTEXT as HUMAN
from hardwareharness_backend.application import DefaultAuthorizer
from hardwareharness_backend.application.services import DevicesApplication
from hardwareharness_backend.devices import DeviceCatalogService, DeviceService, DeviceStore
from hardwareharness_backend.devices.deploy import (
    DeployService,
    DeploySpec,
    load_bundle,
    pipeline,
    service,
)
from hardwareharness_backend.devices.deploy import bundle as bundle_module
from hardwareharness_backend.devices.deploy.hosts import sftp_path

ROOT = r"E:\pci1762_server"
INSTALL = "'install.ps1')"  # quoted so that it does not match 'uninstall.ps1'
TOKEN = "existing-t0ken-value"
Record = dict[str, Any]


def make_bundle(tmp_path: Path, server_id: str = "PCI1762_MCP") -> Path:
    root = tmp_path / "dist" / server_id
    (root / "wheels").mkdir(parents=True)
    (root / "wheels" / "a-1.0-py3-none-any.whl").write_bytes(b"wheel")
    (root / "install.ps1").write_text("# install", encoding="utf-8")
    build = {
        "serverId": server_id,
        "hardwareId": "PC1.PCI1762_0",
        "adapter": "pci1762",
        "adapterModule": "hh_adapter_pci1762",
        "manufacturer": "Advantech",
        "model": "PCI-1762",
        "sdkVersion": "0.2.0",
        "sourceRevision": "abc",
        "builtAt": "now",
    }
    (root / "build.json").write_text(json.dumps(build), encoding="utf-8")
    return root


class FakeHost:
    """A Windows computer driven by scripts; ``fail`` names a script marker that exits 1."""

    def __init__(
        self,
        *,
        config: Record | None = None,
        has_build: bool = False,
        state: str = "Absent",
        has_uninstall: bool = True,
        fail: str | None = None,
        corrupt: str | None = None,
    ) -> None:
        self.config, self.has_build, self.state = config, has_build, state
        self.has_uninstall, self.fail, self.corrupt = has_uninstall, fail, corrupt
        self.files: dict[str, bytes] = {}
        self.scripts: list[str] = []

    async def run(self, script: str, timeout_ms: int) -> Record:
        self.scripts.append(script)
        if self.fail and self.fail in script:
            return {"exitCode": 1, "stdout": "", "stderr": f"{self.fail} broke"}
        if "hasUninstall = " in script:
            return self._ok(
                json.dumps(
                    {
                        "hasConfig": self.config is not None,
                        "serverId": (self.config or {}).get("serverId"),
                        "port": (self.config or {}).get("port", 0),
                        "hasBuild": self.has_build,
                        "hasUninstall": self.has_uninstall,
                        "state": self.state,
                    }
                )
            )
        if ").token" in script:
            return self._ok((self.config or {}).get("token", "") + "\n")
        if "Get-FileHash" in script:
            staging = script.split("'")[1]
            listed = [
                {
                    "path": path[len(staging) + 1 :],
                    "sha256": hashlib.sha256(
                        b"tampered" if self.corrupt and path.endswith(self.corrupt) else data
                    ).hexdigest(),
                }
                for path, data in self.files.items()
                if path.startswith(staging + "\\")
            ]
            return self._ok(json.dumps(listed))
        if "/health" in script:
            server_id = (self.config or {}).get("serverId", "PCI1762_MCP")
            return self._ok(json.dumps({"healthy": True, "serverId": server_id}))
        return self._ok("")

    async def upload(self, local: Path, remote: str) -> None:
        self.files[remote] = local.read_bytes()

    async def write_file(self, remote: str, data: bytes) -> None:
        self.files[remote] = data

    @staticmethod
    def _ok(stdout: str) -> Record:
        return {"exitCode": 0, "stdout": stdout, "stderr": ""}


def spec(**changes: Any) -> DeploySpec:
    values: Record = {
        "server_id": "PCI1762_MCP",
        "hardware_id": "PC1.PCI1762_0",
        "root": ROOT,
        "port": 8013,
        "computer_id": "PC1",
    }
    return DeploySpec(**{**values, **changes})


def names(steps: list[Record]) -> list[str]:
    return [item["step"] + ("-" if item.get("skipped") else "") for item in steps]


async def test_new_deploy_runs_every_step_and_keeps_the_token_out_of_logs(tmp_path: Path) -> None:
    host, progress = FakeHost(), list[Record]()
    bundle = load_bundle(make_bundle(tmp_path))
    verify = AsyncMock()
    outcome = await pipeline.deploy(
        host, bundle, spec(), stop_old=AsyncMock(), verify_device=verify, progress=progress.append
    )
    assert names(outcome.steps) == [
        "inspect", "upload", "verify", "config.write", "backup-", "stop-",
        "replace", "install", "check", "start", "health", "device",
    ]  # fmt: skip
    config = json.loads(host.files[ROOT + "\\server.json"])
    assert config["serverId"] == "PCI1762_MCP" and config["port"] == 8013
    assert config["manufacturer"] == "Advantech" and len(config["token"]) >= 32
    verify.assert_awaited_once_with(config["token"], 8013)
    assert outcome.token == config["token"] and outcome.created_config and not outcome.upgraded
    public = json.dumps([outcome.public(), progress, host.scripts])
    assert config["token"] not in public and "token" not in repr(outcome)
    assert any("-AutoStart:$true" in script for script in host.scripts)
    assert "Remove-Item -LiteralPath 'E:\\pci1762_server\\deploy-staging-" in host.scripts[-1]


async def test_upgrade_reuses_the_remote_config_and_safe_stops_first(tmp_path: Path) -> None:
    config = {"serverId": "PCI1762_MCP", "port": 8099, "token": TOKEN}
    host = FakeHost(config=config, has_build=True, state="Running")
    stop = AsyncMock()
    outcome = await pipeline.deploy(host, load_bundle(make_bundle(tmp_path)), spec(), stop_old=stop)
    assert names(outcome.steps)[:7] == [
        "inspect", "config.read", "upload", "verify", "backup", "stop", "replace",
    ]  # fmt: skip
    stop.assert_awaited_once()
    assert outcome.token == TOKEN and outcome.port == 8099 and outcome.upgraded
    assert ROOT + "\\server.json" not in host.files
    assert TOKEN not in json.dumps(outcome.public())
    # The vendor CLIs compiled on the remote computer survive every replace and backup.
    wipes = [script for script in host.scripts if "Test-Kept" in script]
    assert wipes and all("'native', 'app'" in script for script in wipes)


async def test_install_failure_restores_the_backup_and_restarts(tmp_path: Path) -> None:
    config = {"serverId": "PCI1762_MCP", "port": 8013, "token": TOKEN}
    host = FakeHost(config=config, has_build=True, state="Running", fail=INSTALL)
    with pytest.raises(Exception) as caught:
        await pipeline.deploy(
            host, load_bundle(make_bundle(tmp_path)), spec(), stop_old=AsyncMock()
        )
    error: Any = caught.value
    assert error.category == "error" and "failed at install" in str(error)
    steps = names(error.details["steps"])
    assert steps[steps.index("install") :][:4] == [
        "install", "rollback.stop", "rollback.restore", "rollback.install",
    ]  # fmt: skip
    # The rollback install fails too in this fake, so the old version is not restarted.
    assert error.details["rolledBack"] is False and "rollback.start" not in steps


async def test_health_failure_rolls_back_to_the_previous_version(tmp_path: Path) -> None:
    config = {"serverId": "PCI1762_MCP", "port": 8013, "token": TOKEN}
    host = FakeHost(config=config, has_build=True, state="Running", fail="/health")
    with pytest.raises(Exception) as caught:
        await pipeline.deploy(
            host, load_bundle(make_bundle(tmp_path)), spec(), stop_old=AsyncMock()
        )
    error: Any = caught.value
    assert names(error.details["steps"])[-4:] == [
        "rollback.stop", "rollback.restore", "rollback.install", "rollback.start",
    ]  # fmt: skip
    assert error.details["rolledBack"] is True and "previous version was restored" in str(error)
    assert any("-Destination $root" in script for script in host.scripts)


async def test_a_failed_safe_stop_replaces_nothing(tmp_path: Path) -> None:
    host = FakeHost(config={"serverId": "PCI1762_MCP", "token": TOKEN}, state="Running")
    stop = AsyncMock(side_effect=RuntimeError("prepare_shutdown refused"))
    with pytest.raises(RuntimeError, match="prepare_shutdown"):
        await pipeline.deploy(host, load_bundle(make_bundle(tmp_path)), spec(), stop_old=stop)
    assert not any(INSTALL in script for script in host.scripts)
    assert not any("Remove-Item -Recurse -Force" in script for script in host.scripts)


async def test_hash_mismatch_and_foreign_roots_stop_before_touching_the_service(
    tmp_path: Path,
) -> None:
    bundle = load_bundle(make_bundle(tmp_path))
    host = FakeHost(corrupt="install.ps1")
    with pytest.raises(Exception, match="SHA-256 mismatch after upload: install.ps1"):
        await pipeline.deploy(host, bundle, spec(), stop_old=AsyncMock())
    assert ROOT + "\\server.json" not in host.files
    foreign = FakeHost(config={"serverId": "OTHER_MCP", "token": TOKEN})
    with pytest.raises(Exception, match="belongs to 'OTHER_MCP'"):
        await pipeline.deploy(foreign, bundle, spec(), stop_old=AsyncMock())
    with pytest.raises(Exception, match="built for PCI1762_MCP"):
        await pipeline.deploy(FakeHost(), bundle, spec(server_id="X"), stop_old=AsyncMock())


def test_roots_bundles_and_sftp_paths(tmp_path: Path) -> None:
    assert pipeline.validate_root("E:\\a_server\\") == "E:\\a_server"
    for bad in ("E:\\", "relative\\x", "E:\\a\\..\\b", "\\\\host\\share", "E:\\a|b"):
        with pytest.raises(Exception, match="Not a service root"):
            pipeline.validate_root(bad)
    assert pipeline.default_root("PCI1762_MCP") == "E:\\pci1762_mcp_server"
    assert sftp_path("E:\\a\\b.txt") == "/E:/a/b.txt"
    root = make_bundle(tmp_path)
    (root / "server.json").write_text("{}", encoding="utf-8")
    with pytest.raises(Exception, match="must never be part of a bundle"):
        load_bundle(root)
    (root / "server.json").unlink()
    (root / "native" / "build").mkdir(parents=True)
    (root / "native" / "build" / "hwcli_pci1762.exe").write_bytes(b"MZ")
    with pytest.raises(Exception, match="native/build/hwcli_pci1762.exe must never"):
        load_bundle(root)


async def test_uninstall_stops_unregisters_archives_and_deletes() -> None:
    host = FakeHost(config={"serverId": "PCI1762_MCP"}, has_build=True, state="Running",
                    has_uninstall=False)  # fmt: skip
    stop = AsyncMock()
    result = await pipeline.uninstall(
        host, ROOT, "PCI1762_MCP", stop_old=stop, uninstall_script=b"# uninstall"
    )
    assert names(result["steps"]) == [
        "inspect", "stop", "uninstall.write", "unregister", "archive", "remove",
    ]  # fmt: skip
    assert host.files[ROOT + "\\uninstall.ps1"] == b"# uninstall"
    assert result["archive"].startswith("C:\\ProgramData\\HardwareHarness\\backup\\PCI1762_MCP-")
    assert "Compress-Archive" in host.scripts[-2] and "'venv', '.venv'" in host.scripts[-2]
    stop.assert_awaited_once()
    with pytest.raises(Exception, match="belongs to"):
        await pipeline.uninstall(
            FakeHost(config={"serverId": "OTHER"}), ROOT, "PCI1762_MCP", stop_old=stop
        )


def test_assemble_builds_the_bundle_without_secrets(tmp_path: Path) -> None:
    source = tmp_path / "mcp_servers"
    (source / "adapters" / "pci1762").mkdir(parents=True)
    (source / "adapters" / "pci1762" / "pyproject.toml").write_text(
        '[project]\nname = "hh-adapter-pci1762"\nversion = "0.2.0"\ndescription = "relay"\n',
        encoding="utf-8",
    )
    (source / "templates").mkdir()
    for name in bundle_module.SCRIPTS:
        (source / "templates" / name).write_text("# {{ADAPTER_MODULE}}", encoding="utf-8")
    calls: list[list[str]] = []

    def run(command: Sequence[str], cwd: Path) -> str:
        calls.append(list(command))
        if "-c" in command:
            return json.dumps({"manufacturer": "Advantech", "model": "PCI-1762", "sdkVersion": "1"})
        if "build" in command:
            package = command[command.index("--package") + 1].replace("-", "_")
            out = Path(command[command.index("--out-dir") + 1])
            (out / f"{package}-0.2.0-py3-none-any.whl").write_bytes(package.encode())
        if "export" in command:
            return "# comment\npyserial==3.5\n"
        if command[0] == "git":
            return "0123456789abcdef\n" if "rev-parse" in command else ""
        return ""

    bundle = bundle_module.assemble(source, "PCI1762_MCP", "PC1.X", "pci1762", run=run)
    assert bundle.root == (source / "dist" / "PCI1762_MCP").resolve()
    assert (bundle.root / "install.ps1").read_text(encoding="utf-8") == "# hh_adapter_pci1762"
    assert (bundle.root / "requirements.txt").read_text(encoding="utf-8") == "pyserial==3.5\n"
    assert bundle.build["sourceRevision"] == "0123456789ab"
    assert [item["name"] for item in bundle.build["packages"]] == [
        "hardwareharness_device_sdk", "hh_adapter_pci1762",
    ]  # fmt: skip
    assert sum("download" in call for call in calls) == 3
    assert not any(item.relative.endswith("server.json") for item in bundle.files)
    assert bundle_module.list_adapters(source)[0]["module"] == "hh_adapter_pci1762"
    with pytest.raises(Exception, match="Unknown adapter"):
        bundle_module.assemble(source, "X", "Y", "missing", run=run)
    with pytest.raises(Exception, match="Unsafe bundle target"):
        bundle_module.assemble(source, "..", "Y", "pci1762", run=run)


async def deploy_fixture(tmp_path: Path) -> tuple[DevicesApplication, DeviceService, Mock]:
    store = DeviceStore(tmp_path / "devices")
    await store.initialize()
    secrets = Mock(set=AsyncMock(), remove=AsyncMock())
    transports = Mock(
        connect=AsyncMock(side_effect=RuntimeError("offline")),
        disconnect=AsyncMock(),
        list_tools=Mock(return_value=[]),
    )
    devices = DeviceService(store, secrets, transports)
    await devices.save_computer(
        {
            "id": "PC1",
            "label": "PC1",
            "address": "192.168.3.63",
            "ssh": {"username": "u", "shell": "powershell"},
        },
        {"ssh": "secret"},
    )
    catalog = DeviceCatalogService(store)
    deploy = DeployService(devices, catalog, source=lambda: tmp_path)
    app = DevicesApplication(DefaultAuthorizer(), devices, catalog, deploy=deploy)
    return app, devices, secrets


async def test_deploy_service_registers_the_service_and_its_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app, devices, secrets = await deploy_fixture(tmp_path)
    host = FakeHost()
    monkeypatch.setattr(DeployService, "host", lambda self, computer_id: host)
    probe = AsyncMock(
        return_value={"serverId": "PCI1762_MCP", "hardwareId": "PC1.PCI1762_0", "healthy": True}
    )
    monkeypatch.setattr(service, "probe_service", probe)
    bundle_dir = make_bundle(tmp_path)
    result = await app.deploy.deploy(
        "PC1",
        {"serverId": "PCI1762_MCP", "hardwareId": "PC1.PCI1762_0", "adapter": "pci1762",
         "port": 8013},
        bundle_dir=bundle_dir,
    )  # fmt: skip
    token = json.loads(host.files["E:\\pci1762_mcp_server\\server.json"])["token"]
    assert probe.await_args is not None
    assert probe.await_args.args == ("http://192.168.3.63:8013/mcp", token)
    secrets.set.assert_any_await("mcp:PCI1762_MCP", {"token": token})
    saved = devices.store.get_server("PCI1762_MCP")
    assert saved is not None
    assert saved["root"] == "E:\\pci1762_mcp_server" and saved["computerId"] == "PC1"
    assert saved["url"] == "http://192.168.3.63:8013/mcp" and saved["label"] == "Advantech PCI-1762"
    hardware = app.catalog.find_hardware("PC1.PCI1762_0")
    assert hardware is not None and hardware["serverId"] == "PCI1762_MCP"
    assert result["server"]["serverId"] == "PCI1762_MCP" and token not in json.dumps(result)

    # Moving an installed service or deploying it to another computer is refused.
    with pytest.raises(Exception, match="uninstall it before moving it"):
        await app.deploy.deploy(
            "PC1",
            {"serverId": "PCI1762_MCP", "hardwareId": "PC1.PCI1762_0", "adapter": "pci1762",
             "port": 8013, "root": "E:\\elsewhere"},
            bundle_dir=bundle_dir,
        )  # fmt: skip

    # Uninstall: safe stop through the service, then forget the service and its hardware.
    host.config, host.has_build, host.state = {"serverId": "PCI1762_MCP"}, True, "Running"
    server_action = AsyncMock()
    monkeypatch.setattr(devices, "server_action", server_action)
    removed = await app.uninstall_service(HUMAN, "PCI1762_MCP")
    server_action.assert_awaited_once_with("PCI1762_MCP", "stop")
    assert removed["serverId"] == "PCI1762_MCP" and devices.store.get_server("PCI1762_MCP") is None
    assert app.catalog.find_hardware("PC1.PCI1762_0") is None


async def test_an_unregistered_running_service_is_never_stopped_blindly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app, _, _ = await deploy_fixture(tmp_path)
    host = FakeHost(config={"serverId": "PCI1762_MCP", "token": TOKEN}, state="Running")
    monkeypatch.setattr(DeployService, "host", lambda self, computer_id: host)
    with pytest.raises(Exception, match="import it from the computer first") as caught:
        await app.deploy.deploy(
            "PC1",
            {"serverId": "PCI1762_MCP", "hardwareId": "PC1.PCI1762_0", "adapter": "pci1762",
             "port": 8013},
            bundle_dir=make_bundle(tmp_path),
        )  # fmt: skip
    assert getattr(caught.value, "category", None) == "safe_stop_failed"
    assert not any(INSTALL in script for script in host.scripts)


def test_agents_need_the_deploy_capability() -> None:
    authorizer = DefaultAuthorizer()
    assert not authorizer.is_allowed({"actor": "agent"}, "devices.deploy")
    assert authorizer.is_allowed(HUMAN, "devices.deploy")


def test_command_line_builds_the_same_spec_as_the_interface(tmp_path: Path) -> None:
    from hardwareharness_backend.devices.deploy import __main__ as cli

    settings = tmp_path / "settings.json"
    settings.write_text('{"channel": 1}', encoding="utf-8")
    args = cli.parser().parse_args(
        ["deploy", "--user-data", str(tmp_path), "--computer", "PC1", "--server-id", "S",
         "--hardware-id", "H", "--adapter", "pci1762", "--port", "8013",
         "--settings", str(settings), "--no-autostart"]
    )  # fmt: skip
    assert cli._spec(args) == {
        "serverId": "S", "hardwareId": "H", "adapter": "pci1762", "port": 8013,
        "dryRun": False, "autostart": False, "settings": {"channel": 1},
    }  # fmt: skip
    with pytest.raises(SystemExit):
        cli.parser().parse_args(["uninstall", "--server-id", "S"])
