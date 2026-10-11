"""Devices-JC JCXD-DA-CPCI-6401: 64 single-ended static analog outputs, 16 bit, ±10 V.

Hardware manual V1.0: 64 single-ended / 32 differential outputs, 16-bit, ±10 V on the standard
model (±15/±30/±40 V on the -3S/-1S/-5S variants, whose driver value is the volts divided by
1.5/3/4), 20 mA per channel and 100 mA in total, 0.05 %FSR, SCSI-100 connector CON1.

The card has no output readback: ``ao{n}`` streams (``kind="setpoint"``) and ``read_last`` are the
software shadow of accepted writes, never a measured voltage. Measure the outputs with a meter or
with an AI card (the acceptance procedure in README.md uses the UMAD-X-3210).

Only single-ended mode is implemented; differential pairs are not offered.
"""

from __future__ import annotations

import math
from typing import Any

from teststand_device_sdk import (
    DEVICE_ERROR,
    DEVICE_UNREACHABLE,
    INVALID_ARGUMENT,
    Check,
    Device,
    DeviceConfig,
    DeviceError,
    Pinout,
    ScalarStream,
    check_equal,
    model,
    param,
    tool,
)

from .driver import MAX_CARDS, Da6401Driver
from .pinout import pinout as build_pinout
from .sim import SimulatedDa6401

CHANNEL_COUNT = 64
RANGES = {10.0: 1.0, 15.0: 1.5, 30.0: 3.0, 40.0: 4.0}
"""Model range (V) -> divisor of the value passed to WriteVoltage (software manual §3.2.1)."""
SINGLE_ENDED = 0
CARD_TYPE = 0x4204

Voltage = model("DaVoltage", channel=(int, "AO channel 0..63."),
                volts=(float, "Accepted setting in V; not a measured output voltage."))
Voltages = model("DaVoltages", volts=(list[float], "Accepted setting of every channel written, in V."),
                 channels=(list[int], "Channels written, in order."))
SafeResult = model("DaSafe", safeVolts=(float, "Value written to all 64 channels, in V."),
                   failed=(list[int], "Channels whose write failed (may not be at the safe value)."))

Channel = param(int, "AO channel 0..63 (single-ended), as printed on CON1.", ge=0, le=CHANNEL_COUNT - 1)


def setting_float(settings: Any, key: str, default: float) -> float:
    value = float(settings.get(key, default))
    if not math.isfinite(value):
        raise ValueError(f"{key} must be finite")
    return value


class JcxdDa6401(Device):
    manufacturer = "Devices-JC"
    model = "JCXD-DA-CPCI-6401"
    prefix = "da6401"
    capabilities = ("analog_output",)
    isolation = "subprocess"
    version = "1.0.0"
    instructions = ("JCXD-DA-CPCI-6401: 64 static analog outputs (AO0..AO63, single-ended). write_voltage sets "
                    "one channel, set_all sets every channel; nothing is read back from the pins.")
    description = ("Devices-JC JCXD-DA-CPCI-6401, 3U CPCI, 64 single-ended 16-bit static analog outputs on one "
                   "SCSI-100 connector (CON1), ±10 V (standard model; set outputRangeV for -3S/-1S/-5S), "
                   "20 mA per channel, 100 mA total, 0.05 %FSR. No output readback: the ao streams are "
                   "setpoint shadows. Card selected by serialNumber (or cardIndex).")

    def __init__(self, config: DeviceConfig) -> None:
        super().__init__(config)
        settings = config.settings
        self.range_v = setting_float(settings, "outputRangeV", 10.0)
        if self.range_v not in RANGES:
            raise ValueError(f"outputRangeV must be one of {sorted(RANGES)}, got {self.range_v}")
        self.safe_volts = setting_float(settings, "safeVolts", 0.0)
        if abs(self.safe_volts) > self.range_v:
            raise ValueError(f"safeVolts must lie within ±{self.range_v} V")
        serial = settings.get("serialNumber")
        self.serial = int(serial) if serial not in (None, "") else None
        self.card_index = int(settings.get("cardIndex", 0))
        self.driver = self.select_driver(lambda: Da6401Driver(settings.get("dllPath")), SimulatedDa6401)
        self.handle: int | None = None
        self.identity: dict[str, int] = {}
        self.open_report: dict[str, Any] = {}
        self.last: list[float | None] = [None] * CHANNEL_COUNT
        self.ao = [self.streams.add(ScalarStream(f"ao{n}", unit="V", label=f"AO{n}", kind="setpoint"))
                   for n in range(CHANNEL_COUNT)]

    # --- lifecycle ----------------------------------------------------
    def _open_card(self) -> tuple[int, dict[str, int]]:
        """Open the configured card: by serial number (trying every id), else by cardIndex."""
        ids = range(MAX_CARDS) if self.serial is not None else (self.card_index,)
        seen = []
        for card_id in ids:
            rc, handle = self.driver.open(card_id)
            if rc != 0 or handle is None:
                continue
            info_rc, info = self.driver.info(handle)
            if self.serial is None or info.get("serialNumber") == self.serial:
                return handle, {**info, "cardId": card_id, "infoRc": info_rc}
            seen.append(info.get("serialNumber"))
            self.driver.close(handle)
        wanted = f"serial number {self.serial}" if self.serial is not None else f"card id {self.card_index}"
        raise DeviceError(f"JCXD-DA-CPCI-6401 with {wanted} not found (cards seen: {seen})",
                          category=DEVICE_UNREACHABLE, details={"seen": seen})

    def open(self) -> dict[str, Any]:
        handle, identity = self._open_card()
        rc = self.driver.reset(handle)
        if rc != 0:
            self.driver.close(handle)
            raise DeviceError(f"DA6401_JC_ResetDev failed rc={rc}", category=DEVICE_UNREACHABLE)
        failed = [n for n in range(CHANNEL_COUNT) if self.driver.create_channel(handle, n, SINGLE_ENDED) != 0]
        self.handle, self.identity = handle, identity
        self.last = [None] * CHANNEL_COUNT
        self.open_report = {"createFailed": failed}
        return {"identity": identity, "createFailed": failed}

    def close(self) -> dict[str, Any]:
        handle, self.handle = self.handle, None
        if handle is not None:
            self.driver.reset(handle)
            self.driver.close(handle)
        return {"closed": handle is not None}

    def _require(self) -> int:
        if self.handle is None:
            raise DeviceError("Card not open.", category=DEVICE_UNREACHABLE)
        return self.handle

    def _write(self, handle: int, channel: int, volts: float) -> int:
        rc = self.driver.write(handle, channel, volts / RANGES[self.range_v])
        if rc == 0:
            self.last[channel] = volts
            self.ao[channel].publish(volts)
        return rc

    def _check_volts(self, volts: float) -> float:
        if not math.isfinite(volts) or abs(volts) > self.range_v:
            raise DeviceError(f"volts {volts} outside ±{self.range_v} V; refused, never clamped",
                              category=INVALID_ARGUMENT)
        return float(volts)

    # --- tools --------------------------------------------------------
    @tool(kind="actuate", output=Voltage, safety_action="safe_state", effects=("ao_driven",), evidence="observation",
          description="Set one AO channel to a static voltage within the card range (±10 V on the standard model). "
                      "Out-of-range or nonfinite values are refused before the driver call. The result is the "
                      "accepted setting, not a measured voltage; mind the 20 mA per channel / 100 mA total load "
                      "limit.")
    def write_voltage(self, channel: Channel,
                      volts: param(float, "Voltage in V within ±outputRangeV.", allow_inf_nan=False)) -> dict[str, Any]:
        value = self._check_volts(volts)
        rc = self._write(self._require(), channel, value)
        if rc != 0:
            raise DeviceError(f"DA6401_JC_DA_WriteVoltage failed rc={rc}", category=DEVICE_ERROR,
                              details={"rc": rc, "channel": channel, "outputMayBeUnchanged": True})
        return {"channel": channel, "volts": value}

    @tool(kind="actuate", output=Voltages, safety_action="safe_state", effects=("ao_driven",), evidence="observation",
          description="Set every AO channel to the same static voltage. Channels whose write fails are listed in "
                      "the error details; the others keep the new value.")
    def set_all(self, volts: param(float, "Voltage in V within ±outputRangeV.", allow_inf_nan=False)) -> dict[str, Any]:
        value = self._check_volts(volts)
        handle = self._require()
        failed = [n for n in range(CHANNEL_COUNT) if self._write(handle, n, value) != 0]
        if failed:
            raise DeviceError(f"{len(failed)} channel(s) not written", category=DEVICE_ERROR,
                              details={"failed": failed, "volts": value})
        return {"volts": [value] * CHANNEL_COUNT, "channels": list(range(CHANNEL_COUNT))}

    @tool(kind="read", output=Voltage, evidence="software_shadow",
          description="The last setting accepted on one channel in this session (software shadow). The card has no "
                      "readback; this is never a measured voltage.")
    def read_last(self, channel: Channel) -> dict[str, Any]:
        self._require()
        value = self.last[channel]
        if value is None:
            raise DeviceError(f"AO{channel} not written in this session", category=DEVICE_ERROR)
        return {"channel": channel, "volts": value}

    @tool(kind="safe", output=SafeResult,
          description="Write safeVolts (default 0 V) to all 64 channels. Failed channels are reported and may not be "
                      "at the safe value.")
    def safe_state(self) -> dict[str, Any]:
        handle = self._require()
        failed = [n for n in range(CHANNEL_COUNT) if self._write(handle, n, self.safe_volts) != 0]
        if failed:
            raise DeviceError(f"safe_state incomplete: {len(failed)} channel(s)", details={"failed": failed})
        return {"safeVolts": self.safe_volts, "failed": failed}

    # --- self-test ----------------------------------------------------
    def self_test(self) -> list[Check]:
        identity = self.identity
        serial = identity.get("serialNumber")
        return [
            check_equal("读板卡信息", identity.get("infoRc"), 0, "DA6401_JC_GetDevParInfo 返回码"),
            check_equal("板卡类型", f"{identity.get('cardType', 0):#x}", f"{CARD_TYPE:#x}", "dwCardType"),
            check_equal("通道数（板卡报告）", identity.get("channelMax"), CHANNEL_COUNT, "dwChMax"),
            Check("序列号", bool(serial) and (self.serial is None or serial == self.serial), serial,
                  self.serial if self.serial is not None else "非零", f"cardId {identity.get('cardId')}"),
            check_equal("64 路输出通道创建", self.open_report.get("createFailed"), [],
                        "DA_CreateVoltChan 单端模式；本卡没有输出回读，输出电压须按 README 验收步骤测量"),
        ]

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        return {"channels": {"minimum": 0, "maximum": CHANNEL_COUNT - 1},
                "voltageRange": {"minimum": -self.range_v, "maximum": self.range_v, "unit": "V"},
                "mode": "single-ended", "safeVolts": self.safe_volts, "outputReadback": False,
                "loadLimit": {"perChannelMa": 20, "totalMa": 100},
                "card": {"serialNumber": self.serial, "cardIndex": self.card_index}}

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)
