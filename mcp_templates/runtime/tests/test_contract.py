import unittest

from testforge_runtime import contract
from testforge_runtime.config import ServerConfig


class ContractTests(unittest.TestCase):
    def test_config_carries_the_single_hardware_identity(self):
        config = ServerConfig(
            serverId="DEMO_MCP",
            hardwareId="DEMO.HW_0",
            manufacturer="Vendor",
            model="Model",
            port=8001,
            token="x",
            simulate=True,
        )
        self.assertEqual(config.hardwareId, "DEMO.HW_0")

    def test_contract_exposes_no_pinout(self):
        # Ports, pins and connector images are authored in TestForge Device Management.
        for removed in ("Pin", "PinFunction", "Connector", "Pinout", "PinoutResponse"):
            self.assertFalse(hasattr(contract, removed), f"{removed} must not return to the server contract")


if __name__ == "__main__":
    unittest.main()
