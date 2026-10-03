from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest

from teststand_backend.application.authorization import (
    HUMAN_REQUEST_CONTEXT,
    DefaultAuthorizer,
)
from teststand_backend.application.services import DevicesApplication
from teststand_backend.devices import (
    DeviceCatalogService,
    DeviceStore,
)
from teststand_backend.devices.device_store import safe_segment


def hardware(identifier: str = "H") -> dict[str, Any]:
    return {
        "hardwareId": identifier,
        "label": identifier,
        "kind": "passive",
        "ports": [{"portId": "J1", "name": "Port", "pins": [{"pinId": "1", "position": 1}]}],
    }


async def test_public_store_import_invalidates_catalog(tmp_path: Path) -> None:
    store = DeviceStore(tmp_path)
    await store.initialize()
    catalog = DeviceCatalogService(store)
    app = DevicesApplication(
        DefaultAuthorizer(), Mock(store=store, list_devices=Mock(return_value=[])), catalog
    )
    await app.save_hardware(HUMAN_REQUEST_CONTEXT, hardware())
    assert catalog.resolve_port("H.J1")["port"]["pins"][0]["pinId"] == "1"
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
    await catalog.save_hardware({**document, "hardwareId": "SECOND"})
    catalog.validate_pins("H.J1", "SECOND.J1", [{"a": "2", "b": "2"}])
    with pytest.raises(RuntimeError, match="has no pin 1"):
        catalog.validate_pins("H.J1", "SECOND.J1", [{"a": "1", "b": "1"}])
    with pytest.raises(RuntimeError, match="has no pin 1"):
        catalog.validate_pins("H.J1", "SECOND.J1", [{"a": "2", "b": "1"}])
    with pytest.raises(RuntimeError, match="Duplicate pin pair"):
        catalog.validate_pins("H.J1", "SECOND.J1", [{"a": "2", "b": "2"}] * 2)
    with pytest.raises(RuntimeError, match="has no port"):
        catalog.resolve_port("H.MISSING")
    with pytest.raises(RuntimeError, match="No hardware matches"):
        catalog.resolve_port("UNKNOWN.J1")
    assert catalog.find_hardware("H") is not None
    assert catalog.hardware_for_device("MISSING") is None
    await catalog.remove_hardware("H")
    assert catalog.find_hardware("H") is None


async def test_store_cache_corruption_and_identifier_boundaries(tmp_path: Path) -> None:
    store = DeviceStore(tmp_path)
    await store.initialize()
    await store.save_hardware(hardware())
    assert store.list_hardware() == store.list_hardware()
    (tmp_path / "hardware/BROKEN").mkdir()
    (tmp_path / "hardware/BROKEN/hardware.json").write_text("broken")
    assert len(store.list_hardware()) == 1
    with pytest.raises(RuntimeError, match="Unknown hardwareId"):
        await store.export_bundle("MISSING")
    assert safe_segment("../a!") == "..%2Fa%21"
    assert safe_segment("..") == "%2E%2E"
    with pytest.raises(RuntimeError, match="Identifier"):
        safe_segment("  ")
