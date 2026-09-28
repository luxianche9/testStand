"""Demo adapter exercising every SDK feature; shared by the SDK tests."""

from __future__ import annotations

from typing import Any, Literal

from hardwareharness_device_sdk import (
    ByteStream,
    Device,
    DeviceError,
    PanelItem,
    SampledStream,
    Stream,
    ToolBinding,
    model,
    param,
    tool,
)

Channel = param(int, "Zero-based output channel 0..3.", ge=0, le=3)
Level = model("DemoLevel", channel=(int, "Channel 0..3."), level=(bool, "Commanded output level."))


class DemoDevice(Device):
    manufacturer = "Acme"
    model = "DEMO-1"
    prefix = "demo"
    capabilities = ("DO", "SERIAL")
    version = "1.2.3"

    def __init__(self, config: Any) -> None:
        super().__init__(config)
        self.levels = [False] * 4
        self.safe_calls = 0
        self.inputs = 0
        self.configured = False
        self.di = self.streams.add(SampledStream("di", label="DI bitmap", sample=self.read_inputs, rate_hz=50,
                                                 value_schema={"type": "integer"}))
        self.ai = self.streams.add(SampledStream("ai0", label="AI0", sample=self.read_ai, rate_hz=50, unit="V",
                                                 requires=("configured",), channel=0))
        self.out = self.streams.add(Stream("do", label="DO shadow", value_schema={"type": "integer"}))
        self.serial = self.streams.add(ByteStream("serial1", label="P1", channel=1))

    def read_inputs(self) -> int:
        return self.inputs

    def read_ai(self) -> float:
        if not self.configured:
            raise DeviceError("AI0 is not configured", category="not_configured")
        return 1.25

    @tool(kind="safe", description="Drive every demo output low; controller state only, failure may leave outputs partially set.")
    def safe_state(self) -> dict[str, Any]:
        self.safe_calls += 1
        self.levels = [False] * 4
        return {"safe": True}

    @tool(kind="actuate", output=Level, safety_action="safe_state", effects=("do_driven",),
          description="Drive one demo output channel to the requested logic level; driver acceptance is not a load measurement.")
    def set_level(self, channel: Channel, level: param(bool, "Requested logic level.")) -> dict[str, Any]:  # type: ignore[valid-type]
        self.levels[channel] = level
        self.out.publish(sum(1 << i for i, value in enumerate(self.levels) if value))
        return {"channel": channel, "level": level}

    @tool(kind="read", description="Read the software shadow of one demo output; this is controller state, never a measurement.")
    def read_level(self, channel: Channel) -> dict[str, Any]:
        return {"channel": channel, "level": self.levels[channel]}

    @tool(kind="configure", effects=("configured",),
          description="Configure the demo analog input so its stream produces values; does not actuate any output channel.")
    def configure(self, mode: param(Literal["fast", "slow"], "Acquisition mode.") = "fast") -> dict[str, Any]:  # type: ignore[valid-type]
        self.configured = True
        return {"mode": mode}

    @tool(kind="actuate", description="Send text on the demo serial port; returned bytes are driver acceptance, not peer receipt.")
    def write_text(self, text: param(str, "UTF-8 payload without automatic newline.")) -> dict[str, Any]:  # type: ignore[valid-type]
        data = text.encode()
        self.serial.tx(data)
        return {"bytes": len(data)}

    @tool(kind="actuate", description="Fail on purpose with a device error carrying partial-effect details for envelope tests.")
    def explode(self) -> dict[str, Any]:
        raise DeviceError("boom", details={"partial": [1]})

    def panel(self) -> list[PanelItem]:
        return [
            PanelItem(id="do0", label="DO0", widget="toggle", stream="do", bit=0,
                      write=ToolBinding(tool="set_level", args={"channel": 0, "level": "$value"})),
            PanelItem(id="ai0", label="AI0", widget="readout", stream="ai0", unit="V", decimals=3),
            PanelItem(id="safe", label="Safe", widget="button", write=ToolBinding(tool="safe_state")),
        ]
