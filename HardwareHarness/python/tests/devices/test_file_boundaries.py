from __future__ import annotations

import io
import json
import struct
import zipfile
from pathlib import Path
from typing import Any

import pytest

from hardwareharness_backend.contracts.validation import ValidationError
from hardwareharness_backend.devices import DeviceStore
from hardwareharness_backend.util import json_loads


def bundle(entries: dict[str, bytes], compression: int = zipfile.ZIP_DEFLATED) -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return stream.getvalue()


def documents() -> dict[str, bytes]:
    return {
        "bundle.json": b'{"formatVersion":2,"kind":"hardware","id":"H"}',
        "hardware.json": b'{"hardwareId":"H","label":"Hardware","ports":[]}',
    }


async def test_image_filesystem_failures_raise_os_errors(tmp_path: Path) -> None:
    store = DeviceStore(tmp_path)
    await store.initialize()
    with pytest.raises(FileNotFoundError):
        await store.put_image("H", None, tmp_path / "missing.png")
    with pytest.raises(OSError):
        await store.put_image("H", None, tmp_path)
    await store.save_hardware({"hardwareId": "H", "label": "Hardware", "kind": "passive"})
    store.image_path("H", "appearance.png").mkdir()
    with pytest.raises(IsADirectoryError):
        await store.put_image_bytes("H", None, b"\x89PNG\r\n\x1a\n")
    assert "appearanceAssetId" not in store.require_hardware("H")


async def test_bundle_json_decoding_order_bom_and_zod_required(tmp_path: Path) -> None:
    store = DeviceStore(tmp_path)
    await store.initialize()
    with pytest.raises(RuntimeError, match="Only formatVersion 2"):
        await store.inspect_bundle(bundle({"bundle.json": b"{}"}))
    broken = "{broken"
    with pytest.raises(Exception) as expected:
        json_loads(broken)
    with pytest.raises(type(expected.value)) as caught:
        await store.inspect_bundle(bundle({**documents(), "hardware.json": broken.encode()}))
    assert str(caught.value) == str(expected.value)
    assert (
        await store.inspect_bundle(
            bundle({name: b"\xef\xbb\xbf" + data for name, data in documents().items()})
        )
    )["hardwareId"] == "H"
    with pytest.raises(ValidationError) as invalid:
        await store.inspect_bundle(bundle({**documents(), "hardware.json": b"{}"}))
    assert [(issue["path"], issue["message"]) for issue in invalid.value.issues] == [
        (["hardwareId"], "Required"),
        (["label"], "Required"),
    ]
    for name, field in [("bundle.json", "formatVersion"), ("hardware.json", "hardwareId")]:
        with pytest.raises(TypeError) as caught:
            await store.inspect_bundle(bundle({**documents(), name: b"null"}))
        assert str(caught.value) == f"Cannot read properties of null (reading '{field}')"


@pytest.mark.parametrize("data", [b"", b"junk", b"PK\x03\x04abc"])
async def test_fflate_empty_input_has_missing_manifest_error(tmp_path: Path, data: bytes) -> None:
    with pytest.raises(RuntimeError, match="Bundle is missing bundle.json"):
        await DeviceStore(tmp_path).inspect_bundle(data)


async def test_fflate_reads_local_entries_without_central_directory_or_crc(tmp_path: Path) -> None:
    archive = bytearray(bundle(documents()))
    without_directory = bytes(archive[: archive.index(b"PK\x01\x02")])
    store = DeviceStore(tmp_path)
    assert (await store.inspect_bundle(without_directory))["hardwareId"] == "H"
    struct.pack_into("<I", archive, 14, 0)
    assert (await store.inspect_bundle(bytes(archive)))["hardwareId"] == "H"
    with pytest.raises(RuntimeError, match="unknown compression type 12"):
        await store.inspect_bundle(bundle(documents(), zipfile.ZIP_BZIP2))


async def test_malformed_manifest_primitives_keep_ts_behavior(tmp_path: Path) -> None:
    for value in [True, 3, "text", []]:
        with pytest.raises(RuntimeError, match="Only formatVersion 2"):
            await DeviceStore(tmp_path).inspect_bundle(
                bundle({"bundle.json": json.dumps(value).encode()})
            )
    for value in [True, 3, "text", []]:
        with pytest.raises(ValidationError) as invalid:
            await DeviceStore(tmp_path).inspect_bundle(
                bundle({**documents(), "hardware.json": json.dumps(value).encode()})
            )
        issues: list[dict[str, Any]] = invalid.value.issues
        assert issues[0]["received"] == "undefined"
