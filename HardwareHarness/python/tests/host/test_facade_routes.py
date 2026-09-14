"""Bind every desktop route's TS argument list against the actual Python controller."""

from __future__ import annotations

import inspect
import io
import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import MagicMock, create_autospec

import pytest

from hardwareharness_backend.application import HardwareHarnessApplication
from hardwareharness_backend.compat import UNDEFINED
from hardwareharness_backend.host.rpc import StdioRpc
from hardwareharness_backend.host.runtime import HUMAN, HostRuntime, Services


def restore(value: Any) -> Any:
    if isinstance(value, dict):
        if value == {"__undefined__": True}:
            return UNDEFINED
        if "__bytes__" in value:
            return bytes(value["__bytes__"])
        return {key: restore(child) for key, child in value.items()}
    if isinstance(value, list):
        return [restore(child) for child in value]
    return value


CASES = restore(json.loads(Path(__file__).with_name("facade-calls.json").read_text("utf-8")))
CASES.append(
    {
        "path": "internal.wiring.addManagedHardwareToCanvas",
        "method": "application.wiring.addManagedHardwareToCanvas",
        "args": ["H"],
    }
)


@pytest.mark.parametrize("case", CASES, ids=[case["path"] for case in CASES])
async def test_desktop_arguments_bind_to_python_controller(case: dict[str, Any]) -> None:
    dependencies = {
        name: MagicMock()
        for name in ("devices", "catalog", "projects", "wiring", "orchestration", "system")
    }
    application = HardwareHarnessApplication(dependencies)
    _, namespace, method = case["method"].split(".")
    name = re.sub(r"(?<!^)(?=[A-Z])", "_", method).lower()
    controller = getattr(application, namespace)
    original = getattr(controller, name)
    target = create_autospec(original, spec_set=True, return_value={"result": "controller"})
    setattr(controller, name, target)
    runtime = HostRuntime(StdioRpc(io.BytesIO(), io.BytesIO()))
    runtime.services = cast(Services, SimpleNamespace(application=application))
    args = [HUMAN, *case["args"]]
    assert await runtime.dispatch(case["method"], {"args": args}) == {"result": "controller"}
    target.assert_called_once()
    signature = inspect.signature(original)
    bound = signature.bind(*target.call_args.args)
    bound.apply_defaults()
    assert bound.arguments["context"] == HUMAN
    if method == "setHardwareImageFromPath":
        assert bound.arguments["port_id"] is None
        assert bound.arguments["source_path"] == "中文 image.png"
    if method == "getRun":
        assert bound.arguments["node_limit"] == 200
    if method == "importBundleForServer":
        assert bound.arguments["data"] == bytes([0, 255, 128])
    assert args[1:] == case["args"]  # Dispatch must not mutate the decoded caller payload.
