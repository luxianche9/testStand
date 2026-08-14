from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from testforge_sim_hardware.config import AnalogInputConfig, ServerConfig, load_config


def config_payload(driver: dict | None = None) -> dict:
    return {
        "serverId": "SIM_AI_MCP",
        "hardwareId": "SIM_PC.SIM_AI_0",
        "label": "AI",
        "manufacturer": "TestForge",
        "model": "Virtual AI",
        "host": "127.0.0.1",
        "port": 8101,
        "token": "token",
        "driver": driver or {"kind": "analog_input", "values": [1, 2, 3, 4]},
    }


class ConfigTests(unittest.TestCase):
    def test_parses_typed_analog_input_config(self) -> None:
        config = ServerConfig.model_validate(config_payload())
        self.assertIsInstance(config.driver, AnalogInputConfig)
        self.assertEqual(config.driver.values, (1.0, 2.0, 3.0, 4.0))

    def test_rejects_non_loopback_host(self) -> None:
        value = config_payload()
        value["host"] = "0.0.0.0"
        with self.assertRaisesRegex(ValidationError, "loopback"):
            ServerConfig.model_validate(value)

    def test_rejects_wrong_channel_count_and_out_of_range_value(self) -> None:
        for values in ([1, 2, 3], [1, 2, 3, 11]):
            with self.subTest(values=values), self.assertRaises(ValidationError):
                ServerConfig.model_validate(config_payload({"kind": "analog_input", "values": values}))

    def test_environment_overrides_identity_port_and_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "server.json"
            path.write_text(json.dumps(config_payload()), encoding="utf-8")
            overrides = {
                "TESTFORGE_SERVER_ID": "OVERRIDE",
                "TESTFORGE_HARDWARE_ID": "OVERRIDE.HW",
                "TESTFORGE_PORT": "9001",
                "TESTFORGE_MCP_TOKEN": "override-token",
            }
            with patch.dict(os.environ, overrides, clear=False):
                config = load_config(path)
        self.assertEqual(config.server_id, "OVERRIDE")
        self.assertEqual(config.hardware_id, "OVERRIDE.HW")
        self.assertEqual(config.port, 9001)
        self.assertEqual(config.token, "override-token")


if __name__ == "__main__":
    unittest.main()

