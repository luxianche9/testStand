"""Demo adapter exercising every SDK feature; shared by the SDK tests."""

from __future__ import annotations

import threading
from typing import Any, Literal

from hardwareharness_device_sdk import (
    BitsStream,
    BlobStream,
    BlockStream,
    ByteStream,
    Device,
    DeviceError,
    ScalarStream,
    model,
    param,
    tool,
)

Channel = param(int, "Zero-based output channel 0..3.", ge=0, le=3)
Level = model("DemoLevel", channel=(int, "Channel 0..3."), level=(bool, "Commanded output level."))
PNG = bytes.fromhex("89504e470d0a1a0a") + b"demo"


class DemoDevice(Device):
    manufacturer = "Acme"
    model = "DEMO-1"
    prefix = "demo"
    capabilities = ("DO", "DI", "AI", "SERIAL")
    version = "1.2.3"
    description = "Demo board with four digital outputs, digital inputs, one analog input and a loopback serial port."

    def __init__(self, config: Any) -> None:
        super().__init__(config)
        self.levels = [False] * 4
        self.safe_calls = 0
        self.inputs = 0
        self.configured = False
        self.sent: list[bytes] = []
        self.di = self.streams.add(BitsStream("di", sample=lambda: self.read_inputs(), rate_hz=50,
                                                 width=4, bit_labels=("DI0", "DI1", "DI2", "DI3")))
        self.ai = self.streams.add(ScalarStream("ai0", sample=lambda: self.read_ai(), rate_hz=50, unit="V",
                                                   label="AI0"))
        self.scope = self.streams.add(BlockStream("scope", read_block=lambda: ([1.0, 2.0, 3.0, 4.0], 1.0), rate_hz=20))
        self.out = self.streams.add(BitsStream("do", width=4, kind="setpoint"))
        self.serial = self.streams.add(ByteStream("serial1", writer=self._write))
        self.camera = self.streams.add(BlobStream("cam"))

    def read_inputs(self) -> int:
        return self.inputs

    def read_ai(self) -> float:
        if not self.configured:
            raise DeviceError("AI0 is not configured", category="not_configured")
        return 1.25

    def _write(self, data: bytes) -> None:
        """Loopback peer: answers every line with ``OK`` shortly after, like a modem."""
        self.sent.append(data)
        threading.Timer(0.02, self.serial.rx, args=(b"OK\r\n",)).start()

    def _publish_levels(self) -> None:
        self.out.publish(sum(1 << i for i, value in enumerate(self.levels) if value))

    @tool(kind="safe", description="Drive every demo output low; controller state only, failure may leave outputs partially set.")
    def safe_state(self) -> dict[str, Any]:
        self.safe_calls += 1
        self.levels = [False] * 4
        self._publish_levels()
        return {"safe": True}

    @tool(kind="actuate", output=Level, safety_action="safe_state", effects=("do_driven",),
          description="Drive one demo output channel to the requested logic level; driver acceptance is not a load measurement.")
    def set_level(self, channel: Channel, level: param(bool, "Requested logic level.")) -> dict[str, Any]:  # type: ignore[valid-type]
        self.levels[channel] = level
        self._publish_levels()
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
        return {"bytes": self.serial.send(text.encode())}

    @tool(kind="read", description="Capture a demo camera frame into the cam blob stream and return its ref for blob_read.")
    def capture(self) -> dict[str, Any]:
        return {"ref": self.camera.publish(PNG, "image/png")["ref"]}

    @tool(kind="actuate", description="Fail on purpose with a device error carrying partial-effect details for envelope tests.")
    def explode(self) -> dict[str, Any]:
        raise DeviceError("boom", details={"partial": [1]})
