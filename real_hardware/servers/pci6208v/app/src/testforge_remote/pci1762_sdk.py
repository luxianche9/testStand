"""Subprocess adapter for hwcli_pci1762 (DAQNavi JSON-line CLI)."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

_proc: Optional[subprocess.Popen[str]] = None
_lock = threading.Lock()

# The simulated board, used only when HARDWARE_DRY_RUN is set. See
# _dry_run_dispatch below for what is and is not modelled.
_dry_open = False
_dry_relays = 0  # bit i = RELAY i energized


class SdkError(RuntimeError):
    pass


def dry_run() -> bool:
    return os.environ.get("HARDWARE_DRY_RUN", "").strip() in ("1", "true", "TRUE", "yes")


def resolve_hwcli() -> Optional[Path]:
    env = os.environ.get("PCI1762_HWCLI_PATH", os.environ.get("HWCLI_PATH", "")).strip()
    if env:
        p = Path(env)
        if p.is_file():
            return p
    here = Path(__file__).resolve()
    candidates = [
        here.parents[2] / "native" / "build" / "Release" / "hwcli_pci1762.exe",
        here.parents[2] / "native" / "build" / "Debug" / "hwcli_pci1762.exe",
        here.parents[2] / "native" / "build" / "hwcli_pci1762.exe",
        here.parents[2] / "native" / "build" / "hwcli_pci1762",
    ]
    for c in candidates:
        if c.is_file():
            return c
    return None


def start() -> None:
    global _proc
    if dry_run():
        return
    with _lock:
        if _proc is not None and _proc.poll() is None:
            return
        path = resolve_hwcli()
        if path is None:
            raise SdkError(
                "hwcli_pci1762 not found. Build native/ (cmake -S native -B native/build && "
                "cmake --build native/build) or set PCI1762_HWCLI_PATH."
            )
        log.info("Starting hwcli: %s", path)
        _proc = subprocess.Popen(
            [str(path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )


def stop() -> None:
    global _proc
    with _lock:
        if _proc is None:
            return
        try:
            if _proc.poll() is None and _proc.stdin:
                _proc.stdin.write(json.dumps({"cmd": "close"}) + "\n")
                _proc.stdin.flush()
        except Exception:  # noqa: BLE001
            pass
        try:
            _proc.terminate()
            _proc.wait(timeout=3)
        except Exception:  # noqa: BLE001
            try:
                _proc.kill()
            except Exception:  # noqa: BLE001
                pass
        _proc = None


def call(cmd: dict[str, Any]) -> dict[str, Any]:
    if dry_run():
        return _dry_run_dispatch(cmd)

    start()
    assert _proc is not None and _proc.stdin and _proc.stdout
    line = json.dumps(cmd, ensure_ascii=False)
    with _lock:
        if _proc.poll() is not None:
            raise SdkError(f"hwcli exited early with code {_proc.returncode}")
        _proc.stdin.write(line + "\n")
        _proc.stdin.flush()
        resp = _proc.stdout.readline()
        if not resp:
            err_tail = ""
            if _proc.stderr:
                err_tail = _proc.stderr.read()[:500]
            raise SdkError(f"hwcli returned empty response. stderr={err_tail!r}")
    try:
        return json.loads(resp)
    except json.JSONDecodeError as exc:
        raise SdkError(f"hwcli non-JSON response: {resp!r}") from exc


def _dry_run_dispatch(cmd: dict[str, Any]) -> dict[str, Any]:
    """A 16-relay board in about thirty lines.

    This used to echo the command back for every write and every read, which is
    enough to prove the protocol works and not enough to prove anything else:
    `set_relay` then `read_bit` came back with no `value` at all, so a graph that
    closes a relay and checks the readback could not pass without hardware.

    So the state a readback depends on is modelled here. The payload shapes are
    the ones native/hwcli_pci1762.cpp prints, field for field -- a dry run whose
    shape differs from the real board is worse than no dry run, because the graph
    it validates is not the graph that will run.

    Not modelled: DI. Those sixteen lines come from whatever is wired to the
    connector, and inventing a level would be inventing the unit under test.
    They read false.
    """
    global _dry_relays, _dry_open
    c = cmd.get("cmd")

    if c == "enumerate":
        return {
            "ok": True,
            "reachable": True,
            "message": "DRY_RUN enumerate",
            "data": [
                {"index": 0, "deviceNumber": 0, "description": "DemoDevice,BID#0"},
                {"index": 1, "deviceNumber": 1, "description": "PCI-1762,BID#0"},
            ],
        }
    if c == "open":
        _dry_open = True
        _dry_relays = 0
        return {
            "ok": True,
            "reachable": True,
            "message": "DRY_RUN opened",
            "data": {"description": cmd.get("description", "PCI-1762,BID#0"), "portCount": 2},
        }
    if c in ("ping", "self_test"):
        return {"ok": True, "reachable": True, "message": f"DRY_RUN {c}", "data": cmd}

    # Everything below touches the board, and the real CLI answers "Not open"
    # for all of it. Keeping that gate is the point: `open` is the graph
    # author's job now, and a dry run that forgave a missing one would let the
    # mistake through to the bench.
    if not _dry_open:
        return {"ok": False, "reachable": True, "message": "DRY_RUN Not open", "data": None}

    if c == "set_relay":
        channel = int(cmd.get("channel", 0))
        closed = bool(cmd.get("closed", False))
        if closed:
            _dry_relays |= 1 << channel
        else:
            _dry_relays &= ~(1 << channel)
        return {
            "ok": True,
            "reachable": True,
            "message": "DRY_RUN " + ("relay closed (actuates)" if closed else "relay opened"),
            "data": {"channel": channel, "closed": closed,
                     "port": channel // 8, "bit": channel % 8},
        }
    if c == "set_bank":
        _dry_relays = int(cmd.get("mask", 0)) & 0xFFFF
        return {"ok": True, "reachable": True,
                "message": "DRY_RUN set_bank written (actuates)",
                "data": {"mask": _dry_relays}}
    if c == "read_bit":
        channel = int(cmd.get("channel", 0))
        kind = str(cmd.get("kind", "DI")).upper()
        value = bool(_dry_relays >> channel & 1) if kind in ("RELAY", "DO") else False
        return {"ok": True, "reachable": True, "message": "DRY_RUN read_bit",
                "data": {"kind": kind, "channel": channel, "value": value}}
    if c == "safe_state":
        _dry_relays = 0
        return {"ok": True, "reachable": True,
                "message": "DRY_RUN All relays opened (safe_state)",
                "data": {"relays": "all_open"}}
    if c == "close":
        _dry_relays = 0
        _dry_open = False
        return {"ok": True, "reachable": True, "message": "DRY_RUN Closed after safe_state",
                "data": {"open": False}}

    return {"ok": False, "reachable": False, "message": f"DRY_RUN unknown {c}", "data": None}
