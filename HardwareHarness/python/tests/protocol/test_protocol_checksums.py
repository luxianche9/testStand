from __future__ import annotations

import binascii
import random
import zlib

import pytest

from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.protocol import checksums

# CRC RevEng catalogue "check" values (result over ASCII "123456789"), design §6.3.
REVENG_CHECK = {
    "sum8": 0xDD,
    "sum8_neg": 0x23,
    "xor8": 0x31,
    "crc8": 0xF4,
    "crc16_modbus": 0x4B37,
    "crc16_ccitt_false": 0x29B1,
    "crc16_xmodem": 0x31C3,
    "crc16_kermit": 0x2189,
    "crc32": 0xCBF43926,
}


def test_table_matches_design_section_6_3() -> None:
    assert set(checksums.ALGORITHMS) == set(REVENG_CHECK)
    params = {name: a.params for name, a in checksums.ALGORITHMS.items() if a.params}
    assert params["crc8"] == checksums.CrcParams(8, 0x07, 0x00, False, False, 0x00)
    assert params["crc16_modbus"] == checksums.CrcParams(16, 0x8005, 0xFFFF, True, True, 0)
    assert params["crc16_ccitt_false"] == checksums.CrcParams(16, 0x1021, 0xFFFF, False, False, 0)
    assert params["crc16_xmodem"] == checksums.CrcParams(16, 0x1021, 0, False, False, 0)
    assert params["crc16_kermit"] == checksums.CrcParams(16, 0x1021, 0, True, True, 0)
    assert params["crc32"] == checksums.CrcParams(
        32, 0x04C11DB7, 0xFFFFFFFF, True, True, 0xFFFFFFFF
    )


@pytest.mark.parametrize(("name", "check"), sorted(REVENG_CHECK.items()))
def test_check_values(name: str, check: int) -> None:
    algorithm = checksums.ALGORITHMS[name]
    assert algorithm.check == check
    assert checksums.compute(name, checksums.CHECK_INPUT) == check
    assert algorithm.size == algorithm.width // 8
    assert 0 <= checksums.compute(name, b"") < 1 << algorithm.width


def test_crcs_agree_with_stdlib_implementations() -> None:
    rng = random.Random(6)
    for _ in range(50):
        data = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 64)))
        assert checksums.compute("crc32", data) == zlib.crc32(data)
        assert checksums.compute("crc16_xmodem", data) == binascii.crc_hqx(data, 0)
        assert checksums.compute("crc16_ccitt_false", data) == binascii.crc_hqx(data, 0xFFFF)


def test_simple_sums() -> None:
    assert checksums.compute("sum8", bytes([0xFF, 0x02])) == 0x01
    assert checksums.compute("sum8_neg", bytes([0x01])) == 0xFF
    assert (checksums.compute("sum8", b"abc") + checksums.compute("sum8_neg", b"abc")) & 0xFF == 0
    assert checksums.compute("xor8", bytes([0x0F, 0xF0, 0x01])) == 0xFE


def test_unknown_algorithm_is_rejected() -> None:
    with pytest.raises(AppError) as caught:
        checksums.compute("crc16_custom", b"")
    assert caught.value.category == "invalid_argument"
    assert "crc16_modbus" in str(caught.value)
