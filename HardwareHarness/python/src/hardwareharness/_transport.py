"""Private runner transport. Credentials never form part of the user API."""

from __future__ import annotations

import json
import os
import threading
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_cancelled = threading.Event()
_cancel_delivered = threading.Event()


class HardwareHarnessError(RuntimeError):
    def __init__(self, category: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.category, self.details = category, details


class RunCancelled(BaseException):
    """Cooperative cancellation must survive ordinary application exception handlers."""


def check_cancelled() -> None:
    if _cancelled.is_set() and not _cancel_delivered.is_set():
        _cancel_delivered.set()
        raise RunCancelled("Run cancelled")


def request(operation: str, data: dict[str, Any]) -> Any:
    if operation == "call":
        check_cancelled()
    url = os.environ.get("HARDWAREHARNESS_WORKER_URL")
    token = os.environ.get("HARDWAREHARNESS_WORKER_TOKEN")
    if not url or not token:
        raise RuntimeError("This code must be launched by HardwareHarness")
    payload = json.dumps({"operation": operation, "data": data}, allow_nan=False).encode("utf-8")
    message = Request(
        url,
        data=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    timeout = max(15.0, float(data.get("timeoutMs") or 30_000) / 1000 + 5)
    try:
        with urlopen(message, timeout=timeout) as response:
            result = json.loads(response.read())
    except HTTPError as error:
        try:
            result = json.loads(error.read())
        except (ValueError, OSError) as malformed:
            raise HardwareHarnessError(
                "unavailable", "HardwareHarness rejected the request"
            ) from malformed
    except (URLError, TimeoutError, OSError) as error:
        raise HardwareHarnessError(
            "unavailable", "HardwareHarness connection lost; remote operation result is unknown"
        ) from error
    if not isinstance(result, dict):
        raise HardwareHarnessError("invalid_response", "Invalid HardwareHarness response")
    if "error" in result:
        failure = result["error"]
        raise HardwareHarnessError(failure["category"], failure["message"], failure.get("details"))
    return result.get("result")
