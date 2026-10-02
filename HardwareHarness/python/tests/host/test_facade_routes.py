"""Every renderer call, as the preload sends it, binds to the actual Python controller."""

from __future__ import annotations

import inspect
import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, create_autospec

import pytest

from hardwareharness_backend.application import HardwareHarnessApplication
from hardwareharness_backend.application.registry import OperationRegistry
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.contracts.wire import to_json
from hardwareharness_backend.host.http_api import RENDERER_CONTEXT
from hardwareharness_backend.host.runtime import SERVICE_OPERATIONS, service_targets
from hardwareharness_backend.util import UNDEFINED


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


CASES = restore(
    json.loads(Path(__file__).with_name("desktop-facade-calls.json").read_text("utf-8"))
)
CASES.append(
    {
        "path": "internal.wiring.addManagedHardwareToCanvas",
        "method": "application.wiring.addManagedHardwareToCanvas",
        "args": ["H"],
    }
)


def body(operation: str, args: list[Any]) -> bytes:
    """The preload's request body: positional arguments by wire name, ``undefined`` left out."""
    names = [wire for wire, _ in SERVICE_OPERATIONS[operation].parameters]
    assert len(args) <= len(names), f"{operation} takes {len(names)} arguments"
    named = {
        name: value for name, value in zip(names, args, strict=False) if value is not UNDEFINED
    }
    return json.dumps(to_json(named)).encode()


def registry() -> tuple[HardwareHarnessApplication, OperationRegistry]:
    dependencies: dict[str, Any] = {
        name: MagicMock() for name in ("devices", "catalog", "projects", "wiring", "system")
    }
    application = HardwareHarnessApplication(dependencies)
    return application, OperationRegistry(
        service_targets(application, MagicMock()), SERVICE_OPERATIONS
    )


@pytest.mark.parametrize("case", CASES, ids=[case["path"] for case in CASES])
async def test_desktop_arguments_bind_to_python_controller(case: dict[str, Any]) -> None:
    application, operations = registry()
    operation = case["method"].removeprefix("application.")
    definition = SERVICE_OPERATIONS[operation]
    controller = getattr(application, definition.namespace)
    original = getattr(controller, definition.method)
    target = create_autospec(original, spec_set=True, return_value={"result": "controller"})
    setattr(controller, definition.method, target)
    args = list(case["args"])
    result = await operations.invoke(dict(RENDERER_CONTEXT), operation, body(operation, args))
    assert result == {"result": "controller"}
    target.assert_called_once()
    signature = inspect.signature(original)
    bound = signature.bind(*target.call_args.args, **target.call_args.kwargs)
    bound.apply_defaults()
    assert bound.arguments["context"] == RENDERER_CONTEXT
    if definition.method == "set_hardware_image_from_path":
        assert bound.arguments["port_id"] is None
        assert bound.arguments["source_path"] == "中文 image.png"
    if definition.method == "import_bundle_for_server":
        assert bound.arguments["data"] == bytes([0, 255, 128])
    assert args == case["args"]  # Dispatch must not mutate the caller's payload.


async def test_unknown_operations_and_extra_fields_are_rejected() -> None:
    _, operations = registry()
    with pytest.raises(AppError, match="Unknown operation") as unknown:
        await operations.invoke(dict(RENDERER_CONTEXT), "devices.__dict__", None)
    assert unknown.value.category == "not_found"
    with pytest.raises(AppError, match="Invalid request") as extra:
        await operations.invoke(dict(RENDERER_CONTEXT), "system.dashboard", b'{"actor":"x"}')
    assert extra.value.category == "invalid_argument"
    assert extra.value.details["issues"][0]["type"] == "extra_forbidden"
