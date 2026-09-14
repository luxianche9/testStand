"""Bounded, isolated pyOCD operation. JSON stdin/stdout; diagnostics on stderr."""
from __future__ import annotations

import base64
import json
import sys
from contextlib import redirect_stdout

from pyocd.core.session import Session
from pyocd.flash.loader import FlashLoader
from pyocd.probe.aggregator import DebugProbeAggregator
from pyocd.probe.debug_probe import DebugProbe

from .firmware import OperationError, validate_segments
from .diagnostics import validate_sram_read


def probes() -> list[dict]:
    return [{"serialNumber": probe.unique_id, "vendor": probe.vendor_name,
             "product": probe.product_name} for probe in DebugProbeAggregator.get_all_connected_probes()
            if "cmsis" in type(probe).__module__.lower()]


def verify_bytes(target, segments: list[tuple[int, bytes]]) -> int:
    verified = 0
    for address, data in segments:
        for offset in range(0, len(data), 4096):
            expected = data[offset:offset + 4096]
            actual = bytes(target.read_memory_block8(address + offset, len(expected)))
            if actual != expected:
                mismatch = next(i for i, (a, b) in enumerate(zip(actual, expected)) if a != b) if len(actual) == len(expected) else 0
                raise OperationError(f"Flash read-back mismatch at {hex(address + offset + mismatch)}", "verification_failed")
            verified += len(expected)
    return verified


def execute(request: dict) -> dict:
    if request["operation"] == "read_sram":
        validate_sram_read(request["readAddress"], request["readLength"])
    if request["operation"] == "list_probes":
        return {"probes": probes()}
    config = request["config"]
    serial = config.get("probeSerial")
    matches = [probe for probe in DebugProbeAggregator.get_all_connected_probes()
               if probe.unique_id == serial and "cmsis" in type(probe).__module__.lower()]
    if len(matches) != 1:
        raise OperationError("Configured FireDAP serial is not connected (or not unique)", "device_unreachable")
    operation = request["operation"]
    # auto_unlock=False is essential: never erase a protected target to connect.
    session = Session(matches[0], auto_open=True, options={
            "target_override": "stm32f407zg", "pack": config["packPath"],
            "frequency": config.get("frequencyHz", 1000000), "connect_mode": "attach",
            "auto_unlock": False, "resume_on_disconnect": False,
            "load_deprecated_devices": True, "no_config": True,
            "dap_protocol": "swd",
            "hide_programming_progress": True,
        })
    if session is None:
        raise OperationError("Unable to open configured FireDAP", "device_unreachable")
    with session:
        target = session.target
        if session.probe.wire_protocol != DebugProbe.Protocol.SWD:
            raise OperationError("Expected SWD protocol", "invalid_response")
        if target.is_locked():
            raise OperationError("Target is read protected. Automatic unlocking is disabled", "target_protected")
        device_id = target.read32(0xE0042000)
        flash_kib = target.read16(0x1FFF7A22)
        if device_id & 0xFFF != 0x413 or flash_kib != 1024:
            raise OperationError(f"Target mismatch: DBGMCU_IDCODE={hex(device_id)}, Flash={flash_kib} KiB; expected F405/407 group with 1024 KiB", "target_mismatch")
        identity = {"probeSerial": serial, "target": "stm32f407zg", "deviceId": hex(device_id),
                    "flashKiB": flash_kib, "uid": [hex(target.read32(0x1FFF7A10 + i * 4)) for i in range(3)],
                    "identityLimit": "DBGMCU identifies the F405/F407 group, not package or board revision"}
        if operation == "target_info":
            return {**identity, "coreState": str(target.get_state())}
        if operation == "read_sram":
            address, length = request["readAddress"], request["readLength"]
            raw = bytes(target.read_memory_block8(address, length))
            if len(raw) != length:
                raise OperationError("Incomplete SRAM read", "invalid_response")
            return {**identity, "coreState": str(target.get_state()), "address": address,
                    "length": length, "words": [int.from_bytes(raw[i:i+4], "little") for i in range(0, length, 4)]}
        if operation == "reset":
            target.reset()
            return {**identity, "reset": True}
        if operation not in {"flash", "verify"}:
            raise OperationError("Unknown worker operation")
        segments = validate_segments([(item["address"], base64.b64decode(item["base64"], validate=True))
                                      for item in request["segments"]])
        if operation == "flash":
            # Attach can inherit active DMA, watchdogs and Flash/cache state from
            # the user's application. Reset into a halted state before loading
            # an algorithm into SRAM; never run the application while programming.
            target.reset_and_halt()
            # Sector erase only; restore bytes outside the supplied image in affected sectors.
            loader = FlashLoader(session, chip_erase="sector", smart_flash=True,
                                 trust_crc=False, keep_unwritten=True)
            for address, data in segments:
                loader.add_data(address, data)
            loader.commit()
        verified = verify_bytes(target, segments)
        if operation == "flash" and request.get("resetAfter", True):
            target.reset()
        return {**identity, "verifiedBytes": verified, "verified": True,
                "programmed": operation == "flash", "reset": operation == "flash" and request.get("resetAfter", True)}


def main() -> None:
    try:
        request = json.load(sys.stdin)
        # pyOCD and pack algorithms may emit progress on stdout. Reserve stdout
        # exclusively for the JSON response, including on programming failure.
        with redirect_stdout(sys.stderr):
            data = execute(request)
        result = {"ok": True, "data": data}
    except Exception as exc:
        result = {"ok": False, "error": {"category": getattr(exc, "category", "device_unreachable"), "message": str(exc)}}
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
