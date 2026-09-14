"""Bounded, read-only access to main SRAM; no peripheral side-effect reads."""
from .firmware import OperationError


def validate_sram_read(address: int, length: int) -> None:
    if type(address) is not int or type(length) is not int:
        raise OperationError("SRAM address and length must be integers")
    if length < 4 or length > 4096 or address % 4 or length % 4:
        raise OperationError("Read 4..4096 bytes, with 4-byte aligned address and length")
    if address < 0x20000000 or address + length > 0x20020000:
        raise OperationError("Read range must stay within STM32F407 main SRAM (0x20000000..0x2001FFFF)")
