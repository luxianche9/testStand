"""Child process of the devkit: check or describe one adapter on its simulator.

    python -m teststand_backend.devkit.runner check <adapter-root> <adapter>
    python -m teststand_backend.devkit.runner describe <adapter-root> <adapter>
    teststand-backend.exe --devkit check ...   (frozen backend)

It imports the agent's code, so it never runs in the service process. The last stdout line
starting with ``@@devkit-result@@`` carries the JSON result; everything else is the log the
agent reads (pytest output, tracebacks).
"""

from __future__ import annotations

import importlib
import json
import logging
import sys
import traceback
from pathlib import Path
from typing import Any

RESULT_MARK = "@@devkit-result@@ "
Record = dict[str, Any]


def _emit(result: Record) -> None:
    sys.stdout.flush()
    sys.stdout.write(
        "\n" + RESULT_MARK + json.dumps(result, ensure_ascii=False, default=str) + "\n"
    )
    sys.stdout.flush()


def _load(root: Path, adapter: str) -> Any:
    sys.path.insert(0, str(root / "src"))
    from teststand_device_sdk import Device

    module = importlib.import_module(f"teststand_adapter_{adapter}")
    device = getattr(module, "DEVICE", None)
    if not (isinstance(device, type) and issubclass(device, Device)):
        raise TypeError(
            f"teststand_adapter_{adapter}.DEVICE must be the Device subclass (DEVICE = MyDevice)"
        )
    return device


class _Collector:
    """pytest plugin: the outcome of every test, with a short failure text."""

    def __init__(self) -> None:
        self.passed: list[str] = []
        self.failed: list[Record] = []
        self.skipped: list[str] = []

    def pytest_runtest_logreport(self, report: Any) -> None:
        if report.when == "call" and report.passed:
            self.passed.append(report.nodeid)
        elif report.failed:
            text = str(report.longreprtext or "")
            self.failed.append({"test": report.nodeid, "when": report.when, "error": text[-3000:]})
        elif report.skipped and report.when in {"setup", "call"}:
            self.skipped.append(report.nodeid)

    def pytest_collectreport(self, report: Any) -> None:
        if report.failed:
            text = str(report.longreprtext or "")
            self.failed.append({"test": report.nodeid, "when": "collect", "error": text[-3000:]})


def _tests(root: Path) -> Record:
    tests = root / "tests"
    if not tests.is_dir() or not any(tests.glob("test_*.py")):
        return {"ran": False, "passed": 0, "failed": [], "note": "no tests/test_*.py"}
    import pytest

    collector = _Collector()
    code = pytest.main(
        [
            str(tests),
            "-q",
            "-p",
            "no:cacheprovider",
            "--import-mode=importlib",
            f"--rootdir={root}",
            "-c",
            str(root / "pyproject.toml"),
            "-o",
            "addopts=",
        ],
        plugins=[collector],
    )
    return {
        "ran": True,
        "exitCode": int(code),
        "passed": len(collector.passed),
        "failed": collector.failed,
        "skipped": len(collector.skipped),
    }


def _declaration(device_cls: Any) -> Record:
    """What the device declares, as the agent and the bench will see it."""
    from teststand_device_sdk.testing import serve

    with serve(device_cls) as harness:
        declaration = harness.device()
        tools = [
            {
                "name": name,
                "kind": item["_meta"]["teststand"]["kind"],
                "description": str(item.get("description", ""))[:160],
            }
            for name, item in harness.tools.items()
        ]
    streams = declaration.get("streams", [])
    return {
        "identity": declaration.get("identity"),
        "description": str(declaration.get("description", ""))[:400],
        "tools": tools,
        "streams": [
            {
                key: stream.get(key)
                for key in ("id", "type", "kind", "unit", "label", "writable", "control")
                if stream.get(key) is not None
            }
            for stream in (streams if isinstance(streams, list) else [])
        ],
        "pinout": declaration.get("pinout", {}).get("status")
        if isinstance(declaration.get("pinout"), dict)
        else None,
    }


def check(root: Path, adapter: str) -> Record:
    from teststand_device_sdk.testing import check_device, dry_run_config

    result: Record = {"ok": False, "warnings": []}
    try:
        device_cls = _load(root, adapter)
    except Exception:
        result["error"] = "The adapter does not import:\n" + traceback.format_exc(limit=8)
        result["tests"] = _tests(root)
        return result
    warnings: list[str] = []
    try:
        failures = check_device(device_cls, dry_run_config(device_cls), warnings=warnings)
    except Exception:
        failures = ["The compliance suite crashed:\n" + traceback.format_exc(limit=8)]
    result["compliance"] = {"ok": not failures, "failures": failures}
    result["warnings"] = warnings
    try:
        result["declaration"] = _declaration(device_cls)
    except Exception:
        result["declaration"] = {"error": traceback.format_exc(limit=6)}
    result["tests"] = _tests(root)
    tests = result["tests"]
    result["ok"] = not failures and (not tests["ran"] or (tests["exitCode"] == 0))
    return result


def describe(root: Path, adapter: str) -> Record:
    device_cls = _load(root, adapter)
    return {
        "ok": True,
        "manufacturer": device_cls.manufacturer,
        "model": device_cls.model,
        "isolation": device_cls.isolation,
        "description": device_cls.description,
    }


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    if len(arguments) != 3 or arguments[0] not in {"check", "describe"}:
        _emit({"ok": False, "error": "usage: runner check|describe <adapter-root> <adapter>"})
        return 2
    command, root, adapter = arguments
    try:
        result = (check if command == "check" else describe)(Path(root), adapter)
    except Exception:
        result = {"ok": False, "error": traceback.format_exc(limit=8)}
    _emit(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
