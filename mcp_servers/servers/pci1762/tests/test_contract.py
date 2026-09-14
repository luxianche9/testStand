import unittest

from hardwareharness_server.config import ServerConfig
from hardwareharness_server.pinout import build_pinout


class ContractTests(unittest.TestCase):
    def test_template_pin_ids_follow_stable_contract(self):
        config = ServerConfig(serverId="DEMO_MCP", hardwareId="DEMO.HW_0", manufacturer="Vendor", model="Model", port=8001, token="x", simulate=True)
        pinout = build_pinout(config)
        self.assertEqual(pinout.connectors[0].connectorId, "DEMO.HW_0.J1")
        self.assertEqual(pinout.pins[0].pinId, "DEMO.HW_0.J1.1")
        self.assertEqual(len({pin.pinId for pin in pinout.pins}), len(pinout.pins))


if __name__ == "__main__":
    unittest.main()
