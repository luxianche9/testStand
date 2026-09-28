"""Widget templates for the canvas: one setpoint per AO channel plus safe state."""

from __future__ import annotations

from hardwareharness_device_sdk import VALUE, PanelItem, ToolBinding, ValueRange

from .pinout import ao_pin


def items(hardware_id: str, safe_volts: float) -> list[PanelItem]:
    result = [
        PanelItem(
            id=f"ao{channel}", label=f"AO{channel}", group="Analog output", widget="number",
            description="Commanded setpoint; the displayed value is the accepted write, not a measurement.",
            stream=f"ao{channel}", unit="V", decimals=3, range=ValueRange(min=-10, max=10, step=0.01), confirm=True,
            write=ToolBinding(tool="set_voltage", args={"channel": channel, "volts": VALUE}),
            read=ToolBinding(tool="read_last", args={"channel": channel}),
            pins=(ao_pin(hardware_id, channel),),
        )
        for channel in range(8)
    ]
    result.append(PanelItem(id="safe_state", label=f"All AO to safe ({safe_volts:g} V)", group="Safety",
                            widget="button", write=ToolBinding(tool="safe_state")))
    return result
