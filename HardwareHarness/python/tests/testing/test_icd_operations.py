"""ICD authoring operations (U5): list, read, check with trial decode, save."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from hardwareharness_backend.application import DefaultAuthorizer
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.projects.icd_library import IcdLibrary
from hardwareharness_backend.protocol import checksums
from hardwareharness_backend.testing import TestingApplication

from .test_testing import HUMAN, Projects

ACK_YAML = """\
formatVersion: 1
name: dut_ack
transport: bytes
framing:
  kind: header_length
  header: "AA 55"
  lengthField: {offset: 2, size: 1}
  lengthCovers: payload
  trailer: checksum
checksum: {algorithm: crc16_modbus, range: {from: 2, to: -2}, offset: -2, endian: little}
messages:
  - name: ack
    match: {offset: 3, value: 0x01}
    fields:
      - {name: code, offset: 4, type: u8}
encoders:
  - name: ping
    template: {header: "AA 55", cmd: 0x02}
    fields: []
"""


def ack_frame(code: int) -> bytes:
    body = b"\xaa\x55\x02\x01" + bytes([code])
    return body + checksums.compute("crc16_modbus", body[2:]).to_bytes(2, "little")


def application(root: Path) -> TestingApplication:
    resolver = SimpleNamespace(icds=IcdLibrary(Projects(root)))
    return TestingApplication(DefaultAuthorizer(), None, None, resolver, None)


async def test_check_save_list_and_read(tmp_path: Path) -> None:
    app = application(tmp_path)
    assert app.list_icds(HUMAN) == []

    frame = ack_frame(7).hex()
    checked = app.check_icd(
        HUMAN, {"text": ACK_YAML, "alias": "dut", "samples": [frame[:6], frame[6:], "AA"]}
    )
    assert checked["valid"] is True
    assert checked["icd"]["messages"] == ["ack"]
    assert {"streamId": "dut.ack.code", "type": "scalar"} in checked["icd"]["streams"]
    assert checked["decoded"]["dut.ack"][0]["fields"] == {"code": 7}
    assert [record["v"] for record in checked["decoded"]["dut.ack.code"]] == [7]
    [unframed] = checked["decoded"]["dut.$unframed"]  # the trailing lone byte is flushed
    assert unframed["data"] == "aa"

    saved = await app.save_icd(HUMAN, {"name": "dut_ack", "text": ACK_YAML})
    assert saved["icd"]["icdHash"] == checked["icd"]["icdHash"]
    assert (tmp_path / "icd" / "dut_ack.icd.yaml").read_text(encoding="utf-8") == ACK_YAML
    [listed] = app.list_icds(HUMAN)
    assert listed["valid"] is True and listed["encoders"] == ["ping"]
    read = app.read_icd(HUMAN, "dut_ack")
    assert read["text"] == ACK_YAML and read["icd"]["name"] == "dut_ack"
    assert app.check_icd(HUMAN, {"name": "dut_ack"})["valid"] is True


async def test_invalid_icds_are_reported_and_never_written(tmp_path: Path) -> None:
    app = application(tmp_path)
    broken = ACK_YAML.replace("algorithm: crc16_modbus", "algorithm: crc99")
    checked = app.check_icd(HUMAN, {"text": broken})
    assert checked["valid"] is False and checked["issues"]
    assert app.check_icd(HUMAN, {"text": "name: [unclosed"})["valid"] is False

    with pytest.raises(AppError):
        await app.save_icd(HUMAN, {"name": "dut_ack", "text": broken})
    with pytest.raises(AppError):  # the declared name must match the file name
        await app.save_icd(HUMAN, {"name": "other", "text": ACK_YAML})
    assert not (tmp_path / "icd").exists() or not any((tmp_path / "icd").iterdir())

    (tmp_path / "icd").mkdir(exist_ok=True)
    (tmp_path / "icd" / "dut_ack.icd.yaml").write_text(broken, encoding="utf-8")
    read = app.read_icd(HUMAN, "dut_ack")
    assert read["valid"] is False and read["text"] == broken
