"""JCXD-SDS48-X CON1 and CON2 (J30J-74ZKWP7-J): hardware manual V2.0.0, tables 3-5.

CON1 carries relays 0-11 and 24-35, CON2 relays 36-47 and 12-23 on the same positions: the CON2
relay is the CON1 relay + 36 for 0-11 and - 12 for 24-35 (table 5 against table 3). Each relay is
single-pole double-throw: OT_COMn common, OT_CLn normally closed, OT_OPn normally open.
"""

from __future__ import annotations

from teststand_device_sdk import PinFunction, Pinout, function, multi_connector_pinout, nc

SOURCE = "JCXD-SDS48-X 用户手册-硬件 V2.0.0, 表 3 / 表 5 连接器定义, 表 4 管脚功能描述"
CONNECTOR_TYPE = "J30J-74ZKWP7-J"
PIN_COUNT = 74

CON1 = """COM0 OP0 CL24 COM1 OP1 CL25 COM2 OP2 CL26 COM3 OP3 CL27 COM4 OP4 CL28 COM5 OP5 CL29 COM6 OP6
CL0 COM24 OP24 CL1 COM25 OP25 CL2 COM26 OP26 CL3 COM27 OP27 CL4 COM28 OP28 CL5 COM29 OP29 CL6
NC COM35 OP35 CL11 COM34 OP34 CL10 COM33 OP33 CL9 COM32 OP32 CL8 COM31 OP31 CL7 COM30 OP30
NC CL35 COM11 OP11 CL34 COM10 OP10 CL33 COM9 OP9 CL32 COM8 OP8 CL31 COM7 OP7 CL30""".split()
"""CON1 positions 1..74 in order (table 3)."""

ROLES = {"COM": "common", "OP": "normally open", "CL": "normally closed"}


def con2_channel(channel: int) -> int:
    return channel + 36 if channel < 12 else channel - 12


def split(name: str) -> tuple[str, int]:
    role = name.rstrip("0123456789")
    return role, int(name[len(role):])


def table(connector: str) -> dict[int, str]:
    """Position -> signal (``OT_COM5`` or ``NC``) for ``CON1`` or ``CON2``."""
    result = {}
    for position, name in enumerate(CON1, start=1):
        if name != "NC":
            role, channel = split(name)
            name = f"OT_{role}{con2_channel(channel) if connector == 'CON2' else channel}"
        result[position] = name
    return result


def pinout(hardware_id: str) -> Pinout:
    connectors = []
    for connector in ("CON1", "CON2"):
        functions: dict[int, tuple[PinFunction, ...]] = {}
        for position, signal in table(connector).items():
            if signal == "NC":
                functions[position] = (nc(),)
                continue
            role, channel = split(signal[3:])
            functions[position] = (function(signal, "passive", "relay_dry_contact", channel_kind="relay",
                                            channel_index=channel,
                                            description=f"Relay {channel} {ROLES[role]} contact"),)
        connectors.append((connector, CONNECTOR_TYPE, PIN_COUNT, functions))
    return multi_connector_pinout(hardware_id, "Devices-JC", "JCXD-SDS48-CPCI", connectors, SOURCE)
