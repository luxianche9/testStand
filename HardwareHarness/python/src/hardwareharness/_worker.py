"""Private independent process entry point; never imported by user workflows."""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import io
import json
import os
import sys
import threading
import traceback
from pathlib import Path
from typing import Any

from . import _span, _transport


class _Output(io.TextIOBase):
    encoding = "utf-8"

    def __init__(self, kind: str) -> None:
        self.kind = kind

    def writable(self) -> bool:
        return True

    def write(self, value: str) -> int:
        if value:
            _transport.request(
                "event", {"type": self.kind, "spanId": _span.get(), "data": {"text": value}}
            )
        return len(value)


async def _execute(entrypoint: Path, inputs: Any, stop: threading.Event) -> Any:
    loop = asyncio.get_running_loop()
    current = asyncio.current_task()
    assert current is not None

    def monitor() -> None:
        while not stop.wait(0.1):
            try:
                state = _transport.request("control", {})
                if state.get("cancelled"):
                    _transport._cancelled.set()
                    if inspect.iscoroutinefunction(main):
                        _transport._cancel_delivered.set()
                        loop.call_soon_threadsafe(current.cancel)
                    return
            except Exception:
                _transport._cancelled.set()
                loop.call_soon_threadsafe(current.cancel)
                return

    spec = importlib.util.spec_from_file_location("__hardwareharness_workflow__", entrypoint)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load workflow entrypoint")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    main = getattr(module, "main", None)
    if not callable(main):
        raise ValueError("Workflow must define main(inputs)")
    thread = threading.Thread(target=monitor, daemon=True, name="hardwareharness-control")
    thread.start()
    result = main(inputs)
    if inspect.isawaitable(result):
        result = await result
    return result


def main() -> None:
    launch = json.loads(sys.stdin.read())
    root = Path(launch["snapshot"])
    os.chdir(root)
    sys.path.insert(0, str(root))
    sys.path.insert(0, str((root / launch["entrypoint"]).parent))
    sys.stdout = _Output("stdout")
    sys.stderr = _Output("stderr")
    stop = threading.Event()
    try:
        result = asyncio.run(_execute(root / launch["entrypoint"], launch["inputs"], stop))
        _transport.request("complete", {"status": "succeeded", "result": result})
    except (asyncio.CancelledError, _transport.RunCancelled):
        _transport.request("complete", {"status": "cancelled"})
    except BaseException as error:
        if getattr(error, "category", None) == "cancelled":
            _transport.request("complete", {"status": "cancelled"})
            return
        _transport.request(
            "complete",
            {
                "status": "failed",
                "error": {
                    "category": getattr(error, "category", "error"),
                    "message": str(error),
                    "details": getattr(error, "details", None),
                    "traceback": traceback.format_exc(),
                },
            },
        )
    finally:
        stop.set()


if __name__ == "__main__":
    main()
