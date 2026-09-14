from __future__ import annotations

import base64
import hashlib
import io
from pathlib import Path

from elftools.elf.elffile import ELFFile
from intelhex import IntelHex

FLASH_START = 0x08000000
FLASH_END = 0x08100000
MAX_FILE_BYTES = 32 * 1024 * 1024


class OperationError(Exception):
    def __init__(self, message: str, category: str = "invalid_argument"):
        super().__init__(message)
        self.category = category


def validate_segments(segments: list[tuple[int, bytes]]) -> list[tuple[int, bytes]]:
    if not segments:
        raise OperationError("Firmware has no loadable Flash bytes")
    result = sorted(segments)
    end = FLASH_START
    for address, data in result:
        if not data or address < FLASH_START or address + len(data) > FLASH_END:
            raise OperationError("Only STM32F407ZG internal Flash 0x08000000..0x080FFFFF is permitted")
        if address < end:
            raise OperationError("Overlapping firmware load segments")
        end = address + len(data)
    return result


def inspect_firmware(path: str, roots: list[str], base_address: int | None = None,
                     expected_sha256: str | None = None) -> tuple[dict, list[tuple[int, bytes]]]:
    try:
        source = Path(path).expanduser().resolve(strict=True)
    except OSError as exc:
        raise OperationError(f"Firmware file is not accessible: {path}") from exc
    if not any(source.is_relative_to(Path(root).resolve()) for root in roots):
        raise OperationError("Firmware must be inside a configured firmwareRoots directory")
    if not source.is_file() or source.stat().st_size > MAX_FILE_BYTES:
        raise OperationError("Firmware must be a file of at most 32 MiB")
    # Parse and program the same snapshot; never reopen the user path in a worker.
    with source.open("rb") as stream:
        raw = stream.read(MAX_FILE_BYTES + 1)
    if len(raw) > MAX_FILE_BYTES:
        raise OperationError("Firmware exceeds 32 MiB")
    digest = hashlib.sha256(raw).hexdigest()
    if expected_sha256 is not None and expected_sha256.lower() != digest:
        raise OperationError("SHA-256 differs from the reviewed firmware; inspect again")
    suffix = source.suffix.lower()
    if suffix != ".bin" and base_address is not None:
        raise OperationError("base_address is only valid for .bin; HEX/ELF carry their addresses")
    try:
        if suffix == ".bin":
            if base_address is None:
                raise OperationError("A .bin requires an explicit base_address (normally 134217728 / 0x08000000)")
            segments = [(base_address, raw)]
        elif suffix in {".hex", ".ihex"}:
            parsed = IntelHex(io.StringIO(raw.decode("ascii")))
            segments = []
            for start, end in parsed.segments():
                if not FLASH_START <= start < end <= FLASH_END:
                    raise OperationError("HEX contains bytes outside internal Flash")
                segments.append((start, bytes(parsed.tobinarray(start=start, end=end - 1))))
        elif suffix in {".elf", ".axf"}:
            parsed = ELFFile(io.BytesIO(raw))
            if parsed.header.e_machine != "EM_ARM" or parsed.elfclass != 32 or not parsed.little_endian:
                raise OperationError("Expected a 32-bit little-endian ARM ELF/AXF")
            segments = [(int(segment["p_paddr"]), segment.data()) for segment in parsed.iter_segments()
                        if segment["p_type"] == "PT_LOAD" and segment["p_filesz"] > 0]
        else:
            raise OperationError("Supported formats: .bin, .hex, .ihex, .elf, .axf")
        segments = validate_segments(segments)
    except OperationError:
        raise
    except Exception as exc:
        raise OperationError(f"Malformed firmware: {exc}") from exc
    summary = {"path": str(source), "format": suffix[1:], "sha256": digest,
               "fileBytes": len(raw), "programBytes": sum(len(data) for _, data in segments),
               "segments": [{"address": address, "addressHex": hex(address), "length": len(data)}
                            for address, data in segments]}
    return summary, segments


def encode_segments(segments: list[tuple[int, bytes]]) -> list[dict]:
    return [{"address": address, "base64": base64.b64encode(data).decode("ascii")} for address, data in segments]
