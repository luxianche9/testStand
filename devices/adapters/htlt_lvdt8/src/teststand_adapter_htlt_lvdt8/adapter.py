"""HTLT PXI68802W-I: 8-channel LVDT simulator (3/4-wire) on a DB-62 connector.

Manual "8通道LVDT仿真卡使用手册" V2.2: per channel an excitation input EXC_n (≤ 10 Vrms, ≤ 20 kHz,
from the unit under test or the card's internal source) and secondaries VA_n / VB_n (0-10 Vrms).
Output law, confirmed on this board (SN 25021215) with the internal source:

* 3/4-wire: VA = Vexc·tr·(1+p)/2, VB = Vexc·tr·(1-p)/2, so Va+Vb = Vexc·tr and the position seen by
  the reader, (Va-Vb)/(Va+Vb), equals p (-1..1).
* 2-wire: VA = Vexc·tr·|a|, VB = Vexc·tr·|b| (the sign of a/b is the phase).

``tr`` is the transmission ratio (0-10). Open-loop mode only; the card's trace mode is not used.
The excitation reading is the card's measurement; VA/VB are what the card reports for its outputs.
"""

from __future__ import annotations

from typing import Any, Literal

from teststand_device_sdk import (
    DEVICE_ERROR,
    DEVICE_UNREACHABLE,
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

from .driver import HtltDriver, status_name
from .pinout import pinout as build_pinout
from .sim import SimulatedHtlt

CHANNELS = 8
WIRINGS = ("4-wire", "2-wire")
NOT_ENABLED = 21
"""HTLT_CHANNEL_NOT_ENABLE: a disabled channel neither measures excitation nor reports outputs."""
CONSISTENCY = 0.02
"""Relative tolerance between reported VA/VB and the output law at the measured excitation."""

ChannelState = model(
    "LvdtChannel", channel=(int, "Channel 0..7."), enabled=(bool, "Outputs enabled."),
    wiring=(str, "4-wire (3/4-wire, one position) or 2-wire (independent A and B)."),
    excitation=(str, "external (EXC_n input) or internal (card source)."),
    ratio=(float, "Transmission ratio tr."), position=(float, "Position p (4-wire) or A (2-wire), -1..1.", None),
    positionB=(float, "B (2-wire only), -1..1.", None),
    excVrms=(float, "Excitation measured by the card, Vrms; null while the channel is disabled.", None),
    excHz=(float, "Excitation frequency measured, Hz; null while disabled.", None),
    vaVrms=(float, "VA reported by the card, Vrms; null while disabled (outputs off).", None),
    vbVrms=(float, "VB reported by the card, Vrms; null while disabled (outputs off).", None))
SafeResult = model("LvdtSafe", disabled=(list[int], "Channels whose outputs were disabled."),
                   failed=(list[int], "Channels that could not be disabled."))

Channel = param(int, "LVDT channel 0..7 (EXC_n, VA_n, VB_n).", ge=0, le=CHANNELS - 1)
Position = param(float, "Position -1..1 (4-wire: core position p; 2-wire: A).", ge=-1, le=1, allow_inf_nan=False)


def expected_outputs(wiring: str, volts: float, ratio: float, a: float, b: float) -> tuple[float, float]:
    gain = volts * ratio
    if wiring == "2-wire":
        return gain * abs(a), gain * abs(b)
    return gain * (1 + a) / 2, gain * (1 - a) / 2


class HtltLvdt8(Device):
    manufacturer = "HTLT"
    model = "PXI68802W-I"
    prefix = "lvdt"
    capabilities = ("lvdt_simulation",)
    isolation = "subprocess"
    version = "1.0.0"
    instructions = ("PXI68802W-I LVDT simulator, 8 channels. set_position(channel, p) enables the channel and sets "
                    "the core position -1..1 (4-wire: VA = Vexc·tr·(1+p)/2, VB = Vexc·tr·(1-p)/2). Excitation comes "
                    "from EXC_n unless configure_channel selects the internal source. safe_state disables outputs.")
    description = ("HTLT PXI68802W-I, PXI 8-channel LVDT simulator (3/4-wire; 2-wire per channel), excitation input "
                   "≤ 10 Vrms / 20 kHz per channel from the UUT or an internal 2-7 Vrms source, outputs 0-10 Vrms, "
                   "±0.2 %FS (isolated), DB-62. Reports the measured excitation and its own VA/VB.")

    def __init__(self, config: DeviceConfig) -> None:
        super().__init__(config)
        settings = config.settings
        serial = settings.get("serialNumber")
        self.serial = int(serial) if serial not in (None, "") else None
        self.board_id = int(settings.get("boardId", 1))
        self.default_ratio = float(settings.get("transmissionRatio", 1.0))
        self.default_wiring = str(settings.get("wiring", "4-wire"))
        if not 0 <= self.default_ratio <= 10 or self.default_wiring not in WIRINGS:
            raise ValueError("transmissionRatio must be 0..10 and wiring 4-wire or 2-wire")
        self.driver = self.select_driver(lambda: HtltDriver(settings.get("dllPath")), SimulatedHtlt)
        self.handle: int | None = None
        self.identity: dict[str, Any] = {}
        self.setup: dict[int, dict[str, Any]] = {}
        self.position = [self.streams.add(ScalarStream(f"pos{n}", label=f"LVDT{n} position", kind="setpoint"))
                         for n in range(CHANNELS)]
        self.excitation = [self.streams.add(ScalarStream(f"exc{n}", unit="Vrms", label=f"LVDT{n} excitation",
                                                         kind="measured", rate_hz=2.0,
                                                         sample=lambda n=n: self._sample_exc(n)))
                           for n in range(CHANNELS)]

    # --- lifecycle ----------------------------------------------------
    def _check(self, rc: int, what: str, **details: Any) -> None:
        if rc != 0:
            raise DeviceError(f"{what} failed: HTLT_{status_name(rc)}", category=DEVICE_ERROR,
                              details={"rc": rc, "status": status_name(rc), **details})

    def open(self) -> dict[str, Any]:
        rc, handle = self.driver.open(self.board_id, self.serial)
        if rc != 0 or handle is None:
            wanted = f"serial {self.serial}" if self.serial is not None else f"board id {self.board_id}"
            raise DeviceError(f"LVDT simulator {wanted} not opened: HTLT_{status_name(rc)}",
                              category=DEVICE_UNREACHABLE, details={"rc": rc})
        self.handle, self.identity = handle, self.driver.identity(handle)
        for channel in range(CHANNELS):
            self._configure(channel, self.default_wiring, "external", self.default_ratio, None)
        return {"identity": self.identity}

    def close(self) -> dict[str, Any]:
        handle, self.handle = self.handle, None
        if handle is not None:
            for channel in range(CHANNELS):
                self.driver.enable(handle, channel, False)
                self.driver.internal_excitation(handle, channel, 0, 0, False)
            self.driver.close(handle)
        return {"closed": handle is not None}

    def _require(self) -> int:
        if self.handle is None:
            raise DeviceError("Board not open.", category=DEVICE_UNREACHABLE)
        return self.handle

    def _configure(self, channel: int, wiring: str, excitation: str, ratio: float,
                   internal: tuple[float, float] | None) -> None:
        """Reset the channel to the given mode with outputs disabled."""
        handle = self._require()
        self._check(self.driver.reset_channel(handle, channel), "HTLT_ChannelReset", channel=channel)
        self._check(self.driver.enable(handle, channel, False), "HTLT_SetEnable", channel=channel)
        self._check(self.driver.mode(handle, channel, excitation == "internal", wiring == "2-wire"),
                    "HTLT_SetLvdtMode/SetLoopMode", channel=channel)
        if internal is not None:
            self._check(self.driver.internal_excitation(handle, channel, internal[0], internal[1], True),
                        "HTLT_SetInternalExc", channel=channel)
        self.setup[channel] = {"wiring": wiring, "excitation": excitation, "ratio": ratio, "internal": internal,
                                "enabled": False, "position": None, "positionB": None}

    def _readings(self, channel: int) -> tuple[float, float, float, float] | None:
        """(excVrms, excHz, VA, VB), or None for a disabled channel."""
        handle = self._require()
        rc, volts, freq = self.driver.read_excitation(handle, channel)
        if rc == NOT_ENABLED and not self.setup[channel]["enabled"]:
            return None
        self._check(rc, "HTLT_ReadExc", channel=channel)
        rc, va, vb = self.driver.read_output(handle, channel)
        self._check(rc, "HTLT_ReadLvdtOutput", channel=channel)
        return volts, freq, va, vb

    def _state(self, channel: int) -> dict[str, Any]:
        readings = self._readings(channel)
        volts, freq, va, vb = readings if readings is not None else (None, None, None, None)
        config = self.setup[channel]
        return {"channel": channel, "enabled": config["enabled"], "wiring": config["wiring"],
                "excitation": config["excitation"], "ratio": config["ratio"], "position": config["position"],
                "positionB": config["positionB"], "excVrms": volts, "excHz": freq, "vaVrms": va, "vbVrms": vb}

    def _sample_exc(self, channel: int) -> float | None:
        if self.handle is None:
            return None
        readings = self._readings(channel)
        return readings[0] if readings is not None else None

    # --- tools --------------------------------------------------------
    @tool(kind="configure", output=ChannelState, safety_action="safe_state", effects=("lvdt_disabled",),
          description="Reset one channel to a wiring (4-wire = 3/4-wire with one position, 2-wire = independent A/B), "
                      "an excitation source (external EXC_n, or internal 2-7 Vrms / 100-20000 Hz) and a transmission "
                      "ratio 0-10. Leaves the channel's outputs disabled until set_position.")
    def configure_channel(self, channel: Channel,
                          wiring: param(Literal["4-wire", "2-wire"], "Output wiring.") = "4-wire",
                          excitation: param(Literal["external", "internal"], "Excitation source.") = "external",
                          ratio: param(float, "Transmission ratio tr, 0..10.", ge=0, le=10, allow_inf_nan=False) = 1.0,
                          internal_vrms: param(float, "Internal source, Vrms (internal only).", ge=2, le=7) = 5.0,
                          internal_hz: param(float, "Internal source, Hz (internal only).", ge=100, le=20_000) = 2000.0
                          ) -> dict[str, Any]:
        internal = (internal_vrms, internal_hz) if excitation == "internal" else None
        self._configure(channel, wiring, excitation, ratio, internal)
        return self._state(channel)

    @tool(kind="actuate", output=ChannelState, safety_action="safe_state", effects=("lvdt_driven",),
          description="Set a channel's simulated position and enable its outputs. 4-wire: core position p in -1..1 "
                      "(VA = Vexc·tr·(1+p)/2, VB = Vexc·tr·(1-p)/2). 2-wire: A = position, B = position_b. Returns "
                      "the measured excitation and the VA/VB the card reports (not an external measurement).")
    def set_position(self, channel: Channel, position: Position,
                     position_b: param(float, "B for 2-wire, -1..1; ignored in 4-wire.", ge=-1, le=1,
                                       allow_inf_nan=False) = 0.0) -> dict[str, Any]:
        handle = self._require()
        config = self.setup[channel]
        b = position_b if config["wiring"] == "2-wire" else 0.0
        self._check(self.driver.update(handle, channel, config["ratio"], position, b), "HTLT_UpdateLvdtChannel",
                    channel=channel, position=position)
        if not config["enabled"]:
            self._check(self.driver.enable(handle, channel, True), "HTLT_SetEnable", channel=channel)
        config.update(enabled=True, position=position, positionB=b if config["wiring"] == "2-wire" else None)
        self.position[channel].publish(position)
        return self._state(channel)

    @tool(kind="actuate", output=ChannelState, safety_action="safe_state", effects=("lvdt_disabled",),
          description="Disable one channel's outputs (VA and VB go to 0); its configuration is kept. The result carries the "
                      "excitation measured by the card and the VA/VB it reports afterwards.")
    def disable_channel(self, channel: Channel) -> dict[str, Any]:
        self._check(self.driver.enable(self._require(), channel, False), "HTLT_SetEnable", channel=channel)
        self.setup[channel].update(enabled=False)
        return self._state(channel)

    @tool(kind="read", output=ChannelState, evidence="measurement",
          description="Read one channel: configuration, excitation measured by the card (Vrms, Hz) and the VA/VB "
                      "output levels the card reports. Measure VA/VB externally to verify the wiring.")
    def read_channel(self, channel: Channel) -> dict[str, Any]:
        return self._state(channel)

    @tool(kind="safe", output=SafeResult,
          description="Disable the outputs of all 8 channels and switch internal excitation off; channels that could not be "
                      "disabled are listed and may still drive VA/VB.")
    def safe_state(self) -> dict[str, Any]:
        handle = self._require()
        disabled, failed = [], []
        for channel in range(CHANNELS):
            rc = self.driver.enable(handle, channel, False)
            rc = rc or self.driver.internal_excitation(handle, channel, 0, 0, False)
            (failed if rc else disabled).append(channel)
            if channel in self.setup:
                self.setup[channel].update(enabled=False)
        if failed:
            raise DeviceError(f"safe_state incomplete: channels {failed}", details={"failed": failed})
        return {"disabled": disabled, "failed": failed}

    # --- self-test ----------------------------------------------------
    def self_test(self) -> list[Check]:
        identity = self.identity
        serial = identity.get("serialNumber")
        states, errors = {}, {}
        for channel in range(CHANNELS):
            try:
                states[channel] = self._state(channel)
            except DeviceError as exc:
                errors[channel] = str(exc)
        mismatched = {}
        for channel, state in states.items():
            if not state["enabled"]:
                continue
            va, vb = expected_outputs(state["wiring"], state["excVrms"], state["ratio"], state["position"] or 0.0,
                                      state["positionB"] or 0.0)
            scale = max(state["excVrms"] * state["ratio"], 0.1)
            if abs(state["vaVrms"] - va) > CONSISTENCY * scale or abs(state["vbVrms"] - vb) > CONSISTENCY * scale:
                mismatched[channel] = {"reported": [round(state["vaVrms"], 3), round(state["vbVrms"], 3)],
                                       "expected": [round(va, 3), round(vb, 3)]}
        return [
            check_equal("读序列号", identity.get("snRc"), 0, "HTLT_GetSN 返回码"),
            Check("序列号", bool(serial) and (self.serial is None or serial == self.serial), serial,
                  self.serial if self.serial is not None else "非零",
                  f"硬件 {identity.get('hwVersion', 0):#010x}，SDK {identity.get('sdkVersion')}，"
                  f"驱动 {identity.get('driverVersion')}"),
            check_equal("8 通道激磁与输出读取", errors, {},
                        "HTLT_ReadExc / HTLT_ReadLvdtOutput；未使能通道按驱动规定不可读，不计为错误"),
            check_equal("输出与设定一致", mismatched, {},
                        f"按实测激磁和设定位置计算 VA/VB，与板卡报告值相差 ≤ {CONSISTENCY:.0%}（只查已使能通道）。"
                        "这是板卡内部一致性，不是外部测量，接线须按 README 验收步骤测量"),
        ]

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        return {"channels": CHANNELS, "wirings": list(WIRINGS), "positionRange": [-1, 1], "ratioRange": [0, 10],
                "excitation": {"externalMaxVrms": 10, "maxHz": 20000, "internalVrms": [2, 7],
                               "internalHz": [100, 20000]},
                "outputVrms": [0, 10], "loopMode": "open", "outputReadback": "card_reported",
                "defaults": {"wiring": self.default_wiring, "ratio": self.default_ratio},
                "card": {"serialNumber": self.serial, "boardId": self.board_id}}

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)
