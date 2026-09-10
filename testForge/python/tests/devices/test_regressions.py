from __future__ import annotations

import asyncio
import io
import json
import zipfile
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from testforge_backend.application.authorization import HUMAN_REQUEST_CONTEXT, DefaultAuthorizer
from testforge_backend.application.services import DevicesApplication
from testforge_backend.devices import DeviceCatalogService, DeviceStore, HardwareOccupancyManager
from testforge_backend.devices.device_store import safe_segment
from testforge_backend.devices.ssh import _append_output

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452")


def hardware(identifier: str = "H") -> dict[str, Any]:
    return {
        "hardwareId": identifier,
        "label": identifier,
        "kind": "passive",
        "ports": [{"portId": "J1", "name": "Port", "pins": [{"pinId": "1", "position": 1}]}],
    }


async def test_public_store_import_and_image_invalidate_catalog(tmp_path: Path) -> None:
    store = DeviceStore(tmp_path)
    await store.initialize()
    catalog = DeviceCatalogService(store)
    app = DevicesApplication(
        DefaultAuthorizer(), Mock(store=store, list_servers=Mock(return_value=[])), catalog
    )
    await app.save_hardware(HUMAN_REQUEST_CONTEXT, hardware())
    assert catalog.resolve_port("H.J1")["port"]["pins"][0]["pinId"] == "1"
    assert len(catalog.warnings_for_ports("H.J1", "H.J1")) == 2
    await app.set_hardware_image_bytes(HUMAN_REQUEST_CONTEXT, "H", "J1", PNG)
    assert catalog.warnings_for_ports("H.J1", "H.J1") == []
    await app.remove_hardware_image(HUMAN_REQUEST_CONTEXT, "H", "J1")
    assert len(catalog.warnings_for_ports("H.J1", "H.J1")) == 2
    document = {
        **hardware(),
        "ports": [{"portId": "J1", "name": "Imported", "pins": [{"pinId": "2", "position": 2}]}],
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("hardware.json", json.dumps(document))
        archive.writestr(
            "bundle.json", json.dumps({"formatVersion": 2, "kind": "hardware", "id": "H"})
        )
    await app.import_bundle(HUMAN_REQUEST_CONTEXT, out.getvalue())
    catalog.validate_pins("H.J1", "H.J1", [{"a": "2", "b": "2"}])
    with pytest.raises(RuntimeError, match="has no pin 1"):
        catalog.validate_pins("H.J1", "H.J1", [{"a": "1", "b": "1"}])
    with pytest.raises(RuntimeError, match="has no pin 1"):
        catalog.validate_pins("H.J1", "H.J1", [{"a": "2", "b": "1"}])
    with pytest.raises(RuntimeError, match="Duplicate pin pair"):
        catalog.validate_pins("H.J1", "H.J1", [{"a": "2", "b": "2"}] * 2)
    with pytest.raises(RuntimeError, match="has no port"):
        catalog.resolve_port("H.MISSING")
    with pytest.raises(RuntimeError, match="No hardware matches"):
        catalog.resolve_port("UNKNOWN.J1")
    assert catalog.warnings_for_ports("UNKNOWN.J1", "H.J1")[0].startswith("No hardware matches")
    assert catalog.find_hardware("H") is not None
    assert catalog.hardware_for_server("MISSING") is None
    await catalog.remove_hardware("H")
    assert catalog.find_hardware("H") is None


@pytest.mark.parametrize("expiry", ["not-a-timestamp", "", None, 123])
async def test_invalid_remote_expiry_never_grants_lease(expiry: Any) -> None:
    async def remote(_server: Any, _name: str, args: dict[str, Any]) -> Any:
        return {"state": "occupied", "holderId": args.get("holderId"), "expiresAt": expiry}

    store = Mock(list_servers=Mock(return_value=[{"hardwareId": "H", "enabled": True}]))
    manager = HardwareOccupancyManager(store, Mock(call_internal=AsyncMock(side_effect=remote)))
    with pytest.raises(RuntimeError, match="could not be occupied"):
        await manager.acquire("H")
    assert not manager.is_held("H")
    with pytest.raises(RuntimeError, match="must be occupied"):
        manager.require_lease("H")
    await manager.close()


async def test_valid_epoch_lease_can_be_reported_but_cannot_be_used() -> None:
    async def remote(_server: Any, _name: str, args: dict[str, Any]) -> Any:
        return {
            "state": "occupied",
            "holderId": args.get("holderId"),
            "expiresAt": "1970-01-01T00:00:00.000Z",
        }

    store = Mock(list_servers=Mock(return_value=[{"hardwareId": "H", "enabled": True}]))
    manager = HardwareOccupancyManager(store, Mock(call_internal=AsyncMock(side_effect=remote)))
    try:
        assert (await manager.acquire("H"))["state"] == "occupied_by_self"
        assert not manager.is_held("H")
        with pytest.raises(RuntimeError, match="must be occupied"):
            manager.require_lease("H")
    finally:
        await manager.close()


def test_ssh_output_cap_is_utf8_bytes() -> None:
    maximum = 64 * 1024
    output, truncated = _append_output("", ("测试" * maximum).encode(), maximum)
    assert truncated and len(output.encode()) <= maximum
    assert "\ufffd" not in output
    output, truncated = _append_output("ok", b"!", maximum)
    assert output == "ok!" and not truncated


async def test_lease_heartbeat_release_and_expiry() -> None:
    now = "2099-01-01T00:00:00.000Z"
    failure: Exception | None = None
    action_override: dict[str, Any] | None = None
    owner: dict[str, Any] = {}

    async def remote(_server: Any, _name: str, args: dict[str, Any]) -> Any:
        nonlocal owner
        if failure:
            raise failure
        if action_override is not None:
            return action_override
        if args["action"] == "release":
            owner = {"state": "unoccupied"}
        elif args["action"] in {"acquire", "heartbeat"}:
            owner = {
                "state": "occupied",
                "holderId": args["holderId"],
                "holderLabel": "me",
                "expiresAt": now,
            }
        return owner

    manager = HardwareOccupancyManager(
        Mock(
            list_servers=Mock(
                return_value=[
                    {"hardwareId": "H", "enabled": True},
                    {"hardwareId": "D", "enabled": False},
                ]
            )
        ),
        Mock(call_internal=AsyncMock(side_effect=remote)),
    )
    changed, lost = Mock(), Mock()
    manager.set_notifier(changed)
    manager.set_lost_notifier(lost)
    assert manager.list()[0]["state"] == "unknown"
    with pytest.raises(RuntimeError, match="No enabled MCP"):
        await manager.acquire("D")
    await manager.acquire("H")
    lease_id = manager.require_lease("H")
    await manager.acquire("H")
    assert manager.require_lease("H") == lease_id
    await manager.heartbeat()
    assert (await manager.refresh_all())[0]["state"] == "occupied_by_self"
    failure = RuntimeError("offline")
    await manager.heartbeat()
    assert manager.is_held("H")
    assert (await manager.refresh("H"))["state"] == "unknown"
    manager.active["H"]["expiresAt"] = "2000-01-01T00:00:00.000Z"
    await manager.heartbeat()
    assert not manager.is_held("H")
    assert "heartbeat expired" in lost.call_args.args[1]
    failure = None
    await manager.acquire("H")
    action_override = {"state": "occupied", "holderId": "other", "expiresAt": now}
    await manager.heartbeat()
    assert "rejected" in lost.call_args.args[1]
    action_override = None
    await manager.acquire("H")
    assert (await manager.release("H"))["state"] == "unoccupied"
    assert (await manager.release("H"))["state"] == "unoccupied"
    await manager.acquire("H")
    manager.active["H"]["expiresAt"] = "2000-01-01T00:00:00.000Z"
    with pytest.raises(RuntimeError, match="must be occupied"):
        manager.require_lease("H")
    assert "lease expired" in lost.call_args.args[1]
    await manager.close()
    await asyncio.sleep(0)


async def test_store_cache_corruption_legacy_and_image_boundaries(tmp_path: Path) -> None:
    store = DeviceStore(tmp_path)
    await store.initialize()
    await store.save_hardware(hardware())
    assert store.list_hardware() == store.list_hardware()
    (tmp_path / "hardware/BROKEN").mkdir()
    (tmp_path / "hardware/BROKEN/hardware.json").write_text("broken")
    assert len(store.list_hardware()) == 1
    with pytest.raises(RuntimeError, match="Unknown hardwareId"):
        await store.export_bundle("MISSING")
    with pytest.raises(RuntimeError, match="Unknown portId"):
        await store.put_image_bytes("H", "missing", PNG)
    for data in [b"", bytes(10 * 1024 * 1024 + 1)]:
        with pytest.raises(RuntimeError, match="between 1 byte and 10 MB"):
            await store.put_image_bytes("H", None, data)
    with pytest.raises(RuntimeError, match="does not match its extension"):
        await store.put_image_bytes("H", None, PNG, "image.jpg")
    for asset in ["../escape", str(tmp_path), "C:/outside"]:
        with pytest.raises(RuntimeError, match="Unsafe asset path"):
            store.image_path("H", asset)
    await store.put_image_bytes("H", None, PNG)
    await store.put_image_bytes("H", None, b"\xff\xd8\xff", "photo.jpeg")
    assert not store.image_path("H", "appearance.png").exists()
    await store.remove_image("H")
    assert "appearanceAssetId" not in store.require_hardware("H")
    await store.put_image_bytes("H", "J1", b"RIFF0000WEBP", ".webp")
    changed = store.require_hardware("H")
    changed["ports"] = []
    await store.save_hardware(changed)
    assert not store.image_path("H", "ports/J1.webp").exists()
    assert safe_segment("../a!") == "..%2Fa%21"
    assert safe_segment("..") == "%2E%2E"
    with pytest.raises(RuntimeError, match="Identifier"):
        safe_segment("  ")
