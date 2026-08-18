"""Subprocess adapter for hwcli_pci1710l (DAQNavi JSON-line CLI)."""

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
_dry_safe_do_mask = 0
_dry_do = 0  # bit i = DO i driven high
_dry_ai_cfg: dict[int, dict[str, Any]] = {}  # channel -> {signal_type, value_range}
# Same table as signal_name() in native/hwcli_pci1710l.cpp.
_SIGNAL_NAMES = {0: "SingleEnded", 1: "Differential", 2: "PseudoDifferential"}


class SdkError(RuntimeError):
    pass


def dry_run() -> bool:
    return os.environ.get("HARDWARE_DRY_RUN", "").strip() in ("1", "true", "TRUE", "yes")


def resolve_hwcli() -> Optional[Path]:
    env = os.environ.get("PCI1710L_HWCLI_PATH", os.environ.get("HWCLI_PATH", "")).strip()
    if env:
        p = Path(env)
        if p.is_file():
            return p
    here = Path(__file__).resolve()
    candidates = [
        here.parents[2] / "native" / "build" / "Release" / "hwcli_pci1710l.exe",
        here.parents[2] / "native" / "build" / "Debug" / "hwcli_pci1710l.exe",
        here.parents[2] / "native" / "build" / "hwcli_pci1710l.exe",
        here.parents[2] / "native" / "build" / "hwcli_pci1710l",
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
                "hwcli_pci1710l not found. Build native/ (cmake -S native -B native/build && "
                "cmake --build native/build) or set PCI1710L_HWCLI_PATH."
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
    """A 16-DO / 16-DI / 16-AI card in about sixty lines.

    This used to echo the command back for `read_bit`, `set_level` and friends,
    which proves the protocol works and nothing else: driving DO1 high and then
    reading it back came out with no `value` key at all, so a graph that checks
    its own stimulus could not pass without hardware. The payload shapes below
    are the ones native/hwcli_pci1710l.cpp prints, field for field -- a dry run
    whose shape differs from the real board is worse than no dry run, because
    the graph it validates is not the graph that will run.

    Modelled: the open gate, the DO register (which is what a readback of your
    own stimulus depends on), and the configure_ai-before-read_voltage
    precondition, because a graph that forgets it fails on the bench and should
    fail here too.

    Not modelled: DI and the AI voltage itself. Those come from whatever is
    wired to the connector, and inventing a level or a reading would be
    inventing the unit under test. DI reads false; AI reads 0.0 V.
    """
    global _dry_open, _dry_safe_do_mask, _dry_do
    c = cmd.get("cmd")

    if c == "open":
        _dry_open = True
        _dry_safe_do_mask = int(cmd.get("safe_do_mask", 0))
        _dry_do = _dry_safe_do_mask
        _dry_ai_cfg.clear()
        return {
            "ok": True,
            "reachable": True,
            "message": "DRY_RUN opened",
            "data": {
                "description": cmd.get("description", "PCI-1710L,BID#15"),
                "safe_do_mask": _dry_safe_do_mask,
            },
        }
    if c in ("ping", "enumerate", "self_test"):
        return {"ok": True, "reachable": True, "message": f"DRY_RUN {c}", "data": cmd}

    # Everything below touches the board, and the real CLI answers "Not open"
    # for all of it. Keeping that gate is the point: `open` is the graph
    # author's job now, and a dry run that forgave a missing one would let the
    # mistake through to the bench.
    if not _dry_open:
        return {"ok": False, "reachable": True, "message": "DRY_RUN Not open", "data": None}

    if c == "probe_features":
        return {
            "ok": True,
            "reachable": True,
            "message": "DRY_RUN features",
            "data": {
                "channelCountMax": 16,
                "connectionTypes": [{"name": "SingleEnded", "enum": 0}],
                "valueRanges": [{"enum": 1, "label": "+/- 10 V", "min": -10, "max": 10}],
            },
        }
    if c == "configure_ai":
        channel = int(cmd.get("channel", 0))
        signal_type = int(cmd.get("signal_type", 0))
        value_range = int(cmd.get("value_range", 1))
        _dry_ai_cfg[channel] = {"signal_type": signal_type, "value_range": value_range}
        return {
            "ok": True, "reachable": True, "message": "DRY_RUN AI channel configured",
            "data": {"channel": channel, "signal_type": signal_type,
                     "value_range": value_range,
                     "signal": _SIGNAL_NAMES.get(signal_type, "SingleEnded")},
        }
    if c == "read_voltage":
        channel = int(cmd.get("channel", 0))
        cfg = _dry_ai_cfg.get(channel)
        if cfg is None:
            return {"ok": False, "reachable": True,
                    "message": "DRY_RUN AI channel not configured — call configure_ai first",
                    "data": None}
        return {
            "ok": True, "reachable": True, "message": f"DRY_RUN AI{channel} = 0 V",
            "data": {"channel": channel, "volts": 0.0, "raw": 0,
                     "signal": _SIGNAL_NAMES.get(cfg["signal_type"], "SingleEnded"),
                     "value_range": cfg["value_range"]},
        }
    if c == "set_level":
        channel = int(cmd.get("channel", 0))
        level = bool(cmd.get("level", False))
        if level:
            _dry_do |= 1 << channel
        else:
            _dry_do &= ~(1 << channel)
        return {"ok": True, "reachable": True, "message": "DRY_RUN DO set (actuates)",
                "data": {"channel": channel, "level": level}}
    if c == "read_bit":
        channel = int(cmd.get("channel", 0))
        kind = str(cmd.get("kind", "DI"))
        value = bool(_dry_do >> channel & 1) if kind.upper() == "DO" else False
        return {"ok": True, "reachable": True, "message": "DRY_RUN read_bit",
                "data": {"kind": kind, "channel": channel, "value": value}}
    if c == "safe_state":
        _dry_do = _dry_safe_do_mask
        return {"ok": True, "reachable": True, "message": "DRY_RUN DO safe_state applied",
                "data": {"safe_do_mask": _dry_safe_do_mask}}
    if c == "close":
        _dry_do = _dry_safe_do_mask
        _dry_open = False
        return {"ok": True, "reachable": True, "message": "DRY_RUN Closed after safe_state",
                "data": {"open": False}}

    return {"ok": False, "reachable": False, "message": f"DRY_RUN unknown {c}", "data": None}
