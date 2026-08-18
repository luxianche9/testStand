from __future__ import annotations

import unittest

from testforge_remote.adapters import AdapterError
from testforge_remote.lifecycle import HardwareManager
from testforge_remote.pinouts import PINOUTS


class PinoutTests(unittest.TestCase):
    def test_all_hardware_is_available_and_ids_are_unique(self) -> None:
        self.assertEqual(
            set(PINOUTS),
            {
                "PC1_MCP.PCI1710L_CARD_0",
                "PC1_MCP.PCI1762_CARD_0",
                "PC1_MCP.PCI6208V_CARD_0",
                "PC1_MCP.CP118U_I_CARD_0",
            },
        )
        connector_ids: list[str] = []
        pin_ids: list[str] = []
        for pinout in PINOUTS.values():
            connector_ids.extend(connector.connectorId for connector in pinout.connectors)
            pin_ids.extend(pin.pinId for pin in pinout.pins)
        self.assertEqual(len(connector_ids), len(set(connector_ids)))
        self.assertEqual(len(pin_ids), len(set(pin_ids)))

    def test_expected_pin_counts(self) -> None:
        self.assertEqual(len(PINOUTS["PC1_MCP.PCI1710L_CARD_0"].pins), 68)
        self.assertEqual(len(PINOUTS["PC1_MCP.PCI1762_CARD_0"].pins), 62)
        self.assertEqual(len(PINOUTS["PC1_MCP.PCI6208V_CARD_0"].pins), 37)
        self.assertEqual(len(PINOUTS["PC1_MCP.CP118U_I_CARD_0"].pins), 8 * 9)

    def test_model_specific_unused_pins_are_nc(self) -> None:
        for hardware_id, positions in {
            "PC1_MCP.PCI1710L_CARD_0": (57, 58, 59, 23, 24, 25),
            "PC1_MCP.PCI6208V_CARD_0": (9, 12, 15, 18, 27, 30, 33, 36),
        }.items():
            by_position = {pin.position: pin for pin in PINOUTS[hardware_id].pins}
            for position in positions:
                self.assertEqual(by_position[position].functions[0].direction, "nc")

    def test_cp118u_modes_are_complete_and_unknown(self) -> None:
        pinout = PINOUTS["PC1_MCP.CP118U_I_CARD_0"]
        self.assertEqual(pinout.activeMode, "unknown")
        self.assertEqual(pinout.modeSelection, "hardware_dip")
        modes = {mode.mode for mode in pinout.modes}
        self.assertEqual(modes, {"rs232", "rs422_rs485_4wire", "rs485_2wire"})
        for pin in pinout.pins:
            self.assertEqual({function.mode for function in pin.functions}, modes)

    def test_unknown_hardware_is_invalid_argument(self) -> None:
        with self.assertRaises(AdapterError) as caught:
            HardwareManager().get_pinout("missing")
        self.assertEqual(caught.exception.category, "invalid_argument")


if __name__ == "__main__":
    unittest.main()
