"""Widget templates: relay toggles with readback, IDI lamps, bank mask, safe state."""

from __future__ import annotations

from hardwareharness_device_sdk import VALUE, PanelItem, ToolBinding, ValueRange

from .pinout import input_pins, relay_pins


def items(hardware_id: str) -> list[PanelItem]:
    result = [
        PanelItem(id=f"relay{channel}", label=f"RELAY{channel}", group="Relays", widget="toggle", stream="relay",
                  bit=channel, confirm=True, description="Coil control; readback is controller state.",
                  write=ToolBinding(tool="set_relay", args={"channel": channel, "closed": VALUE}),
                  pins=relay_pins(hardware_id, channel))
        for channel in range(16)
    ]
    result.append(PanelItem(id="relay_bank", label="Relay bank mask", group="Relays", widget="number",
                            stream="relay", confirm=True, range=ValueRange(min=0, max=65535, step=1),
                            write=ToolBinding(tool="set_bank", args={"mask": VALUE})))
    result.append(PanelItem(id="di", label="IDI0..15", group="Isolated input", widget="lamp", stream="di", bits=16,
                            pins=input_pins(hardware_id)))
    result.append(PanelItem(id="safe_state", label="Release all relays", group="Safety", widget="button",
                            write=ToolBinding(tool="safe_state")))
    return result
