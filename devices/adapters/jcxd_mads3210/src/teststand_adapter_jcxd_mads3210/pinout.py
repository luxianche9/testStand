"""JCXD-MADS-X-3210 Connector 0 and Connector 1 (Mini SCSI-68): product manual figure 3-3, table 3-2.

The figure draws Connector 0 with pins 68..35 on the left and 34..1 on the right, Connector 1 with
1..34 on the left and 35..68 on the right. The lists below are the figure's columns top to bottom;
``test_pinout_matches_the_manual_figure`` checks spot values read off the figure.
"""

from __future__ import annotations

from teststand_device_sdk import PinFunction, Pinout, function, multi_connector_pinout

SOURCE = "JCXD-MADS-X-3210/-XS 产品手册, 图 3-3 连接器引脚定义, 表 3-2 管脚功能描述"
PIN_COUNT = 68
CONNECTOR_TYPE = "Mini SCSI-68"

CONNECTOR0 = {
    "left": (68, ["DIO0", "DIO2", "DIO4", "DGND", "DIO6", "DIO8", "DIO10", "DGND", "DIO12", "DIO14", "DIO16",
                  "DGND", "DIO18", "DIO20", "DIO22", "PWM_Out_0", "Pulse_GATE_0", "AI_EXT_CLK", "AGND", "VOUT7",
                  "VOUT6", "VOUT5", "AGND", "VIN30", "VIN29", "AGND", "VIN26", "VIN25", "AGND", "VIN22", "VIN21",
                  "AGND", "VIN18", "VIN17"]),
    "right": (34, ["DIO1", "DIO3", "DIO5", "DGND", "DIO7", "DIO9", "DIO11", "DGND", "DIO13", "DIO15", "DIO17",
                   "DGND", "DIO19", "DIO21", "DIO23", "Pulse_In_0", "DGND", "AI_EXT_GATE", "AGND", "AGND", "AGND",
                   "VOUT4", "VIN31", "AGND", "VIN28", "VIN27", "AGND", "VIN24", "VIN23", "AGND", "VIN20", "VIN19",
                   "AGND", "VIN16"]),
}
CONNECTOR1 = {
    "left": (1, ["DIO24", "DIO26", "DIO28", "DGND", "DIO30", "DIO32", "DIO34", "DGND", "DIO36", "DIO38", "DIO40",
                 "DGND", "DIO42", "DIO44", "DIO46", "DGND", "Pulse_In_1", "DGND", "DGND", "VOUT3", "VOUT2", "VOUT1",
                 "AGND", "VIN14", "VIN13", "AGND", "VIN10", "VIN9", "AGND", "VIN6", "VIN5", "AGND", "VIN2", "VIN1"]),
    "right": (35, ["DIO25", "DIO27", "DIO29", "DGND", "DIO31", "DIO33", "DIO35", "DGND", "DIO37", "DIO39", "DIO41",
                   "DGND", "DIO43", "DIO45", "DIO47", "PWM_Out_1", "Pulse_GATE_1", "AI_EXT_DTRG", "AGND", "AGND",
                   "AGND", "VOUT0", "VIN15", "AGND", "VIN12", "VIN11", "AGND", "VIN8", "VIN7", "AGND", "VIN4", "VIN3",
                   "AGND", "VIN0"]),
}


def signals(columns: dict[str, tuple[int, list[str]]]) -> dict[int, str]:
    """Pin position -> signal name; Connector 0 counts down its columns, Connector 1 counts up."""
    table: dict[int, str] = {}
    for first, names in columns.values():
        step = -1 if first in (68, 34) else 1
        for offset, name in enumerate(names):
            table[first + step * offset] = name
    return table


def pin_functions(signal: str) -> tuple[PinFunction, ...]:
    if signal.startswith("VIN"):
        n = int(signal[3:])
        single = function(f"AI{n}", "input", "analog_voltage", channel_kind="AI", channel_index=n, mode="single")
        if n < 16:
            diff = function(f"AI{n}+", "input", "analog_voltage", channel_kind="AI", channel_index=n, mode="differential")
        else:
            diff = function(f"AI{n - 16}-", "input", "analog_voltage", channel_kind="AI", channel_index=n - 16,
                            mode="differential")
        return (single, diff)
    if signal.startswith("VOUT"):
        n = int(signal[4:])
        return (function(f"AO{n}", "output", "analog_voltage", channel_kind="AO", channel_index=n),)
    if signal.startswith("DIO"):
        n = int(signal[3:])
        return (function(signal, "bidirectional", "digital_logic", channel_kind="DIO", channel_index=n,
                         description="TTL; direction set by configure_dio; pull-up by default (JP1-JP6)"),)
    if signal in ("AGND", "DGND"):
        return (function(signal, "ground", "ground"),)
    if signal.startswith("PWM_Out_"):
        n = int(signal[-1])
        return (function(signal, "output", "digital_logic", channel_kind="CT", channel_index=n),)
    if signal.startswith(("Pulse_In_", "Pulse_GATE_")):
        n = int(signal[-1])
        return (function(signal, "input", "digital_logic", channel_kind="CT", channel_index=n),)
    return (function(signal, "input", "digital_logic", description="AD external clock/trigger (not used)"),)


def pinout(hardware_id: str) -> Pinout:
    connectors = []
    for name, columns in (("Connector 0", CONNECTOR0), ("Connector 1", CONNECTOR1)):
        table = signals(columns)
        connectors.append((name, CONNECTOR_TYPE, PIN_COUNT,
                           {position: pin_functions(signal) for position, signal in table.items()}))
    return multi_connector_pinout(hardware_id, "Devices-JC", "JCXD-MADS-CPCI-3210", connectors, SOURCE)
