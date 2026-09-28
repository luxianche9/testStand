"""Widget templates: one terminal per port (live serial stream, text/hex send, port setup), plus safe state."""

from __future__ import annotations

from hardwareharness_device_sdk import VALUE, PanelItem, ToolBinding

from .pinout import port_pins


def items(hardware_id: str, channels: list[int]) -> list[PanelItem]:
    result = [
        PanelItem(id=f"serial{channel}", label=f"P{channel}", group="Serial", widget="terminal",
                  stream=f"serial{channel}", description="rx/tx traffic; configure the port before sending.",
                  write=ToolBinding(tool="write_text", args={"channel": channel, "text": VALUE}),
                  actions={
                      "sendHex": ToolBinding(tool="write_hex", args={"channel": channel, "hex_data": VALUE}),
                      "configure": ToolBinding(tool="configure_port", args={"channel": channel}),
                      "clearRx": ToolBinding(tool="clear_rx", args={"channel": channel}),
                      "status": ToolBinding(tool="get_line_status", args={"channel": channel}),
                  },
                  pins=port_pins(hardware_id, channel))
        for channel in channels
    ]
    result.append(PanelItem(id="safe_state", label="Discard pending TX", group="Safety", widget="button",
                            write=ToolBinding(tool="safe_state")))
    return result
