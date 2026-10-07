from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from teststand_backend.devices import DeviceStore

PREFIX = "packages/devices/src/device-store.test.ts::"


def hardware(identifier: str) -> dict[str, Any]:
    return {
        "formatVersion": 2,
        "hardwareId": identifier,
        "label": identifier,
        "kind": "passive",
        "ports": [
            {"portId": "J1", "name": "J1", "pins": [{"pinId": "1", "position": 1, "label": "TX"}]}
        ],
    }


def instance(identifier: str, hardware_id: str) -> dict[str, Any]:
    return {
        "deviceId": identifier,
        "label": identifier,
        "hardwareId": hardware_id,
        "type": "pci1710l",
        "enabled": True,
    }


def archive(entries: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as file:
        for name, data in entries.items():
            file.writestr(name, data)
    return output.getvalue()


def bundle(identifier: str, label: str | None = None) -> bytes:
    return archive(
        {
            "bundle.json": json.dumps(
                {"formatVersion": 2, "kind": "hardware", "id": identifier}
            ).encode(),
            "hardware.json": json.dumps(
                {
                    "formatVersion": 2,
                    "hardwareId": identifier,
                    "label": label or identifier,
                    "ports": [],
                }
            ).encode(),
        }
    )


async def fixture(tmp_path: Path) -> DeviceStore:
    store = DeviceStore(tmp_path / "devices")
    await store.initialize()
    return store


@pytest.mark.ts_case(PREFIX + "persists canonical files and derives managed hardware")
async def test_canonical(tmp_path: Path) -> None:
    store = await fixture(tmp_path)
    await store.save_hardware(hardware("CARD"))
    await store.save_device(instance("S1", "CARD"))
    saved = store.require_hardware("CARD")
    assert (saved["kind"], saved["deviceId"]) == ("managed", "S1")
    raw = json.loads((store.root / "hardware/CARD/hardware.json").read_text())
    assert raw == {
        "formatVersion": 2,
        "hardwareId": "CARD",
        "label": "S1",  # a device's hardware is named after the device
        "ports": hardware("CARD")["ports"],
        "signals": [],
    }
    assert "credential" not in (store.root / "devices/S1.json").read_text()


@pytest.mark.ts_case(
    PREFIX + "derives a hardware list with one instance index instead of an N+1 directory scan"
)
async def test_one_device_index(tmp_path: Path) -> None:
    store = await fixture(tmp_path)
    for identifier in ["A", "B", "C"]:
        await store.save_hardware(hardware(identifier))
    with patch.object(store, "_read_all", wraps=store._read_all) as read_all:
        assert len(store.list_hardware()) == 3
        # One scan per record kind: hardware, devices.
        assert read_all.call_count == 2


@pytest.mark.ts_case(PREFIX + "enforces one instance per hardware and deletion rules")
async def test_assignment(tmp_path: Path) -> None:
    store = await fixture(tmp_path)
    await store.save_device(instance("S1", "CARD"))
    with pytest.raises(Exception, match="already assigned"):
        await store.save_device(instance("S2", "CARD"))
    with pytest.raises(Exception, match="assigned"):
        await store.remove_hardware("CARD")
    await store.remove_device("S1")
    assert store.get_hardware("CARD") is None  # a device leaves no stray passive part behind


@pytest.mark.ts_case(PREFIX + "round-trips a canonical hardware-only bundle")
async def test_bundle_roundtrip(tmp_path: Path) -> None:
    store = await fixture(tmp_path)
    await store.save_hardware(hardware("DUT_1"))
    data = await store.export_bundle("DUT_1")
    assert b"credential" not in data
    await store.remove_hardware("DUT_1")
    result = await store.import_bundle(data)
    assert result["id"] == "DUT_1" and result["replaced"] is False
    assert store.require_hardware("DUT_1")["ports"] == hardware("DUT_1")["ports"]


@pytest.mark.ts_case(PREFIX + "previews a validated bundle without creating passive hardware")
async def test_preview(tmp_path: Path) -> None:
    store = await fixture(tmp_path)
    result = await store.inspect_bundle(bundle("CARD", "Preview card"))
    assert result["hardwareId"] == "CARD" and result["label"] == "Preview card"
    assert store.list_hardware() == []


async def test_bundles_never_replace_a_device_s_hardware(tmp_path: Path) -> None:
    store = await fixture(tmp_path)
    await store.save_device(instance("S1", "CARD"))
    with pytest.raises(Exception, match="belongs to a device"):
        await store.import_bundle(bundle("CARD", "Updated card"))
    assert store.require_hardware("CARD")["label"] == instance("S1", "CARD")["label"]


@pytest.mark.ts_case(PREFIX + "drops unknown legacy fields during bundle export")
async def test_unknown_fields(tmp_path: Path) -> None:
    store = await fixture(tmp_path)
    await store.save_hardware({**hardware("DUT_1"), "extra": "ignored"})
    data = await store.export_bundle("DUT_1")
    await store.remove_hardware("DUT_1")
    await store.import_bundle(data)
    raw = json.loads((store.root / "hardware/DUT_1/hardware.json").read_text())
    assert "extra" not in raw and "kind" not in raw


@pytest.mark.ts_case(
    PREFIX + "validates a replacement bundle before touching the existing hardware directory"
)
async def test_validate_before_replace(tmp_path: Path) -> None:
    store = await fixture(tmp_path)
    await store.save_hardware(hardware("DUT_1"))
    with zipfile.ZipFile(io.BytesIO(await store.export_bundle("DUT_1"))) as file:
        entries = {name: file.read(name) for name in file.namelist()}
    entries["ports/J1.png"] = b"unexpected"
    with pytest.raises(Exception, match="unexpected entry"):
        await store.import_bundle(archive(entries))
    assert store.require_hardware("DUT_1")["label"] == hardware("DUT_1")["label"]


@pytest.mark.ts_case(
    PREFIX + "rolls a replacement back when the staged directory cannot be installed"
)
async def test_rollback(tmp_path: Path) -> None:
    calls = 0

    async def rename(source: Path, target: Path) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("injected replacement failure")
        source.rename(target)

    store = DeviceStore(tmp_path / "devices", rename=rename)
    await store.initialize()
    await store.save_hardware(hardware("DUT_1"))
    path = store.root / "hardware/DUT_1/hardware.json"
    original = path.read_bytes()
    with pytest.raises(Exception, match="injected replacement failure"):
        await store.import_bundle(bundle("DUT_1", "replacement"))
    assert path.read_bytes() == original


@pytest.mark.ts_case(PREFIX + "preserves and reports the backup when automatic rollback also fails")
async def test_failed_rollback(tmp_path: Path) -> None:
    calls = 0

    async def rename(source: Path, target: Path) -> None:
        nonlocal calls
        calls += 1
        if calls >= 2:
            raise RuntimeError(f"injected rename failure {calls}")
        source.rename(target)

    store = DeviceStore(tmp_path / "devices", rename=rename)
    await store.initialize()
    await store.save_hardware(hardware("DUT_1"))
    with pytest.raises(Exception, match=r"backup preserved at .*DUT_1\.backup-"):
        await store.import_bundle(bundle("DUT_1", "replacement"))
    names = [path.name for path in (store.root / "hardware").iterdir()]
    assert len(names) == 1 and names[0].startswith("DUT_1.backup-")


@pytest.mark.ts_case(PREFIX + "rejects unsafe and oversized bundle entries")
async def test_unsafe_bundle(tmp_path: Path) -> None:
    store = await fixture(tmp_path)
    with zipfile.ZipFile(io.BytesIO(bundle("DUT_1"))) as file:
        entries = {name: file.read(name) for name in file.namelist()}
    with pytest.raises(Exception, match="Unsafe bundle entry"):
        await store.import_bundle(archive({**entries, "../outside.txt": b"1"}))
    with pytest.raises(Exception, match="32 MB limit"):
        await store.import_bundle(archive({**entries, "unused.bin": bytes(32 * 1024 * 1024 + 1)}))


async def test_every_write_notifies(tmp_path: Path) -> None:
    store = await fixture(tmp_path)
    await store.save_hardware(hardware("SILENT"))
    writes: list[None] = []
    store.set_notifier(lambda: writes.append(None))
    await store.save_hardware(hardware("CARD"))
    await store.save_device(instance("S1", "CARD"))
    await store.save_definition("CARD", {"manifestRevision": "1"})
    data = await store.export_bundle("CARD")
    await store.remove_device("S1")
    await store.import_bundle(data)
    await store.remove_hardware("CARD")
    assert len(writes) == 7  # save_device also renames the hardware record after the device


async def test_removing_an_unknown_device_is_harmless(tmp_path: Path) -> None:
    store = await fixture(tmp_path)
    await store.save_hardware(hardware("DUT_1"))
    await store.remove_device("NOBODY")
    assert store.get_hardware("DUT_1") is not None
