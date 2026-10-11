"""JCXD-DA-X-6401 CON1 (SCSI-100): hardware manual V1.0, figure 3-4 (±10 V and -3S models).

The figure repeats a block of four rows ten times — on the right column AO 6k, 6k+2, 6k+4 then
AGND at pins 50-4k..47-4k, on the left AO 6k+1, 6k+3, 6k+5 then AGND at pins 100-4k..97-4k —
followed by AO60..AO63, AGND, NC and three AGND rows. The table below is that figure written out;
``test_pinout_matches_the_manual_figure`` checks it against spot values read off the figure.
"""

from __future__ import annotations

from teststand_device_sdk import PinFunction, Pinout, function, nc, single_connector_pinout

SOURCE = "JCXD-DA-X-6401 用户手册-硬件 V1.0, 图 3-4 连接器引脚定义"
PIN_COUNT = 100


def ao_positions() -> dict[int, int]:
    """AO channel -> CON1 pin, single-ended."""
    positions: dict[int, int] = {}
    for block in range(10):
        for row in range(3):
            positions[6 * block + 2 * row] = 50 - 4 * block - row
            positions[6 * block + 2 * row + 1] = 100 - 4 * block - row
    positions.update({60: 10, 61: 60, 62: 9, 63: 59})
    return positions


AGND_PINS = (*[47 - 4 * block for block in range(10)], *[97 - 4 * block for block in range(10)],
             8, 58, 5, 4, 3, 55, 54, 53)
NC_PINS = (7, 6, 2, 1, 57, 56, 52, 51)


def pinout(hardware_id: str) -> Pinout:
    functions: dict[int, tuple[PinFunction, ...]] = {}
    for channel, position in ao_positions().items():
        functions[position] = (
            function(f"AO{channel}", "output", "analog_voltage", channel_kind="AO", channel_index=channel),
        )
    for position in AGND_PINS:
        functions[position] = (function("AGND", "ground", "analog_ground"),)
    for position in NC_PINS:
        functions[position] = (nc(),)
    return single_connector_pinout(hardware_id, "Devices-JC", "JCXD-DA-CPCI-6401", PIN_COUNT, functions, SOURCE)
