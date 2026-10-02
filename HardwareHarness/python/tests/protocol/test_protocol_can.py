from __future__ import annotations

import sys

import pytest

from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.protocol.can import CAN_EFF_FLAG, DbcDecoder, cantools_available

DBC = """\
VERSION ""

BU_: ECU

BO_ 291 Speed: 2 ECU
 SG_ kmh : 0|16@1+ (0.5,0) [0|1000] "km/h" ECU

BO_ 2147484449 Mode: 1 ECU
 SG_ state : 0|8@1+ (1,0) [0|2] "" ECU

VAL_ 2147484449 state 0 "off" 1 "on" ;
"""


def test_cantools_is_optional(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "cantools", None)
    assert not cantools_available()
    with pytest.raises(AppError) as caught:
        DbcDecoder(DBC, "can")
    assert caught.value.category == "unavailable"
    assert "cantools" in str(caught.value)
    assert CAN_EFF_FLAG == 0x80000000


def test_dbc_decoding_when_installed() -> None:
    pytest.importorskip("cantools")
    decoder = DbcDecoder(DBC, "can")
    [frame, scalar] = decoder.feed({"t": 1.0, "seq": 3, "dir": "rx", "id": 291, "data": "c800"})
    assert frame.stream_id == "can.Speed" and frame.record["fields"] == {"kmh": 100.0}
    assert scalar.stream_id == "can.Speed.kmh" and scalar.record == {"t": 1.0, "seq": 3, "v": 100.0}
    [mode] = decoder.feed({"seq": 4, "id": 0x321 | CAN_EFF_FLAG, "data": "01"})
    assert mode.record["fields"] == {"state": "on"}
    [missing] = decoder.feed({"seq": 5, "id": 0x7FF, "data": "00"})
    assert missing.stream_id == "can.$errors" and missing.record["reason"] == "unmatched"
    with pytest.raises(AppError):
        DbcDecoder("BO_ nonsense", "can")
