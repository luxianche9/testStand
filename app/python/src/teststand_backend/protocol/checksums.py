"""Named checksum and CRC algorithms (design §6.3, DEC-09).

ICD files may only *name* an algorithm from :data:`ALGORITHMS`; they never carry polynomial
code. CRC parameters follow the CRC RevEng catalogue and every entry records the catalogue's
``check`` value (the result over ASCII ``123456789``), which the unit tests verify. To add an
algorithm, extend the table together with its check value.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType

from teststand_backend.contracts.errors import app_error

CHECK_INPUT = b"123456789"


def _reflect(value: int, width: int) -> int:
    result = 0
    for _ in range(width):
        result = (result << 1) | (value & 1)
        value >>= 1
    return result


@dataclass(frozen=True)
class CrcParams:
    """Rocksoft/RevEng model parameters."""

    width: int
    poly: int
    init: int
    refin: bool
    refout: bool
    xorout: int


def _crc_function(params: CrcParams) -> Callable[[bytes], int]:
    width, mask = params.width, (1 << params.width) - 1
    if params.refin:
        poly = _reflect(params.poly, width)
        table = []
        for byte in range(256):
            crc = byte
            for _ in range(8):
                crc = (crc >> 1) ^ poly if crc & 1 else crc >> 1
            table.append(crc)

        def reflected(data: bytes) -> int:
            crc = _reflect(params.init, width)
            for byte in data:
                crc = (crc >> 8) ^ table[(crc ^ byte) & 0xFF]
            if not params.refout:
                crc = _reflect(crc, width)
            return (crc ^ params.xorout) & mask

        return reflected

    top, shift = 1 << (width - 1), width - 8
    table = []
    for byte in range(256):
        crc = byte << shift
        for _ in range(8):
            crc = ((crc << 1) ^ params.poly) if crc & top else crc << 1
        table.append(crc & mask)

    def direct(data: bytes) -> int:
        crc = params.init
        for byte in data:
            crc = ((crc << 8) & mask) ^ table[((crc >> shift) ^ byte) & 0xFF]
        if params.refout:
            crc = _reflect(crc, width)
        return (crc ^ params.xorout) & mask

    return direct


def _sum8(data: bytes) -> int:
    return sum(data) & 0xFF


def _sum8_neg(data: bytes) -> int:
    return -sum(data) & 0xFF


def _xor8(data: bytes) -> int:
    result = 0
    for byte in data:
        result ^= byte
    return result


@dataclass(frozen=True)
class ChecksumAlgorithm:
    name: str
    width: int
    """Result width in bits (a multiple of 8)."""
    check: int
    """Result over :data:`CHECK_INPUT` (RevEng ``check``)."""
    compute: Callable[[bytes], int] = field(repr=False, compare=False)
    params: CrcParams | None = None

    @property
    def size(self) -> int:
        """Result width in bytes."""
        return self.width // 8


def _crc(name: str, check: int, params: CrcParams) -> ChecksumAlgorithm:
    return ChecksumAlgorithm(name, params.width, check, _crc_function(params), params)


ALGORITHMS: Mapping[str, ChecksumAlgorithm] = MappingProxyType(
    {
        algorithm.name: algorithm
        for algorithm in (
            ChecksumAlgorithm("sum8", 8, 0xDD, _sum8),
            ChecksumAlgorithm("sum8_neg", 8, 0x23, _sum8_neg),
            ChecksumAlgorithm("xor8", 8, 0x31, _xor8),
            _crc("crc8", 0xF4, CrcParams(8, 0x07, 0x00, False, False, 0x00)),
            _crc("crc16_modbus", 0x4B37, CrcParams(16, 0x8005, 0xFFFF, True, True, 0x0000)),
            _crc("crc16_ccitt_false", 0x29B1, CrcParams(16, 0x1021, 0xFFFF, False, False, 0)),
            _crc("crc16_xmodem", 0x31C3, CrcParams(16, 0x1021, 0x0000, False, False, 0x0000)),
            _crc("crc16_kermit", 0x2189, CrcParams(16, 0x1021, 0x0000, True, True, 0x0000)),
            _crc(
                "crc32",
                0xCBF43926,
                CrcParams(32, 0x04C11DB7, 0xFFFFFFFF, True, True, 0xFFFFFFFF),
            ),
        )
    }
)
ALGORITHM_NAMES = tuple(ALGORITHMS)


def algorithm(name: str) -> ChecksumAlgorithm:
    try:
        return ALGORITHMS[name]
    except KeyError:
        raise app_error(
            "invalid_argument",
            f"Unknown checksum algorithm {name!r}; choose one of {', '.join(ALGORITHM_NAMES)}",
        ) from None


def compute(name: str, data: bytes) -> int:
    return algorithm(name).compute(bytes(data))
