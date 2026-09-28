"""JSON-line subprocess bridge for vendor SDKs wrapped in a native CLI (``hwcli_*.exe``).

Protocol: one JSON request per stdin line, one JSON response per stdout line,
shaped ``{"ok": bool, "reachable": bool, "message": str, "data": ...}``.
Calls are serialized; the device operation lock already serializes callers,
the internal lock only protects the pipe from background threads.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any, Protocol

from .config import CONFIG_ENV
from .errors import DEVICE_ERROR, DEVICE_UNREACHABLE, INVALID_RESPONSE, DeviceError

log = logging.getLogger(__name__)


class JsonLineBackend(Protocol):
    def call(self, command: Mapping[str, Any]) -> dict[str, Any]: ...

    def stop(self) -> None: ...


def unwrap(response: Mapping[str, Any]) -> Any:
    """Map a ``{"ok","reachable","message","data"}`` response onto data or :class:`DeviceError`."""
    if "ok" not in response:
        raise DeviceError("Malformed CLI response", category=INVALID_RESPONSE, details=dict(response))
    if response["ok"]:
        return response.get("data")
    category = DEVICE_ERROR if response.get("reachable", False) else DEVICE_UNREACHABLE
    raise DeviceError(str(response.get("message") or "Hardware operation failed"), category=category,
                      details=response.get("data"))


def find_executable(name: str, *, explicit: str | None = None, env_names: Iterable[str] = (),
                    roots: Iterable[Path] = ()) -> Path | None:
    """Locate ``name`` from an explicit path, environment variables, then ``<root>/native/build/{Release,Debug,.}``.

    Default roots are the server config directory and its ``app`` subdirectory,
    where historical deployments keep their compiled native CLI.
    """
    for candidate in (explicit, *(os.environ.get(env) for env in env_names)):
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    search = list(roots)
    config = os.environ.get(CONFIG_ENV)
    if config:
        base = Path(config).resolve().parent
        search += [base, base / "app"]
    for root in search:
        for folder in ("Release", "Debug", "."):
            for filename in (f"{name}.exe", name):
                path = root / "native" / "build" / folder / filename
                if path.is_file():
                    return path
    return None


class JsonLineCli:
    """Long-running native CLI speaking JSON lines; started lazily on first call."""

    def __init__(self, path: Path | None, *, name: str, missing_hint: str = "") -> None:
        self.path = path
        self.name = name
        self.missing_hint = missing_hint
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()

    def _start(self) -> subprocess.Popen[str]:
        if self._proc is not None and self._proc.poll() is None:
            return self._proc
        if self.path is None:
            raise DeviceError(f"{self.name} not found. {self.missing_hint}".strip(), category=DEVICE_UNREACHABLE)
        log.info("Starting %s: %s", self.name, self.path)
        self._proc = subprocess.Popen(
            [str(self.path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        return self._proc

    def call(self, command: Mapping[str, Any]) -> dict[str, Any]:
        with self._lock:
            proc = self._start()
            assert proc.stdin is not None and proc.stdout is not None
            if proc.poll() is not None:
                raise DeviceError(f"{self.name} exited early with code {proc.returncode}", category=DEVICE_UNREACHABLE)
            try:
                proc.stdin.write(json.dumps(dict(command), ensure_ascii=False) + "\n")
                proc.stdin.flush()
                line = proc.stdout.readline()
            except OSError as exc:
                raise DeviceError(f"{self.name} pipe failed: {exc}", category=DEVICE_UNREACHABLE) from exc
            if not line:
                tail = proc.stderr.read()[:500] if proc.stderr is not None and proc.poll() is not None else ""
                raise DeviceError(f"{self.name} returned an empty response", category=DEVICE_UNREACHABLE,
                                  details={"stderr": tail})
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise DeviceError(f"{self.name} non-JSON response: {line[:200]!r}", category=INVALID_RESPONSE) from exc
        if not isinstance(value, dict):
            raise DeviceError(f"{self.name} response is not an object", category=INVALID_RESPONSE)
        return value

    def request(self, command: Mapping[str, Any]) -> Any:
        return unwrap(self.call(command))

    def stop(self) -> None:
        with self._lock:
            proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:  # noqa: BLE001 - best effort; the process may already be gone
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
