"""Widget templates: AI readouts with a configure form, DI lamps, DO toggles, safe state."""

from __future__ import annotations

from hardwareharness_device_sdk import VALUE, PanelItem, ToolBinding

from .pinout import pin_id


def items(hardware_id: str) -> list[PanelItem]:
    result: list[PanelItem] = []
    for channel in range(16):
        result.append(PanelItem(
            id=f"ai{channel}", label=f"AI{channel}", group="Analog input", widget="readout", stream=f"ai{channel}",
            unit="V", decimals=4, read=ToolBinding(tool="read_voltage", args={"channel": channel}),
            actions={"configure": ToolBinding(tool="configure_ai", args={"channel": channel})},
            pins=(pin_id(hardware_id, "AI", channel),),
        ))
    result.append(PanelItem(id="configure_ai", label="Configure AI", group="Analog input", widget="form",
                            write=ToolBinding(tool="configure_ai")))
    result.append(PanelItem(id="di", label="DI0..15", group="Digital input", widget="lamp", stream="di", bits=16,
                            pins=tuple(pin_id(hardware_id, "DI", channel) for channel in range(16))))
    for channel in range(16):
        result.append(PanelItem(
            id=f"do{channel}", label=f"DO{channel}", group="Digital output", widget="toggle", stream="do", bit=channel,
            write=ToolBinding(tool="set_level", args={"channel": channel, "level": VALUE}),
            pins=(pin_id(hardware_id, "DO", channel),),
        ))
    result.append(PanelItem(id="safe_state", label="DO to safe mask", group="Safety", widget="button",
                            write=ToolBinding(tool="safe_state")))
    return result
