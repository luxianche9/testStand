from __future__ import annotations

import unittest

from testforge_sim_hardware.config import ServerConfig
from testforge_sim_hardware.drivers import AnalogInputDriver, AnalogOutputDriver, DriverError, SerialDriver, create_driver


def server(driver: dict) -> ServerConfig:
    return ServerConfig.model_validate({
        "serverId": "SIM_MCP",
        "hardwareId": "SIM.HW",
        "label": "Virtual",
        "manufacturer": "TestForge",
        "model": "Virtual",
        "host": "127.0.0.1",
        "port": 8101,
        "token": "token",
        "driver": driver,
    })


class DriverTests(unittest.TestCase):
    def test_analog_input_returns_fixed_single_and_batch_values(self) -> None:
        driver = create_driver(server({"kind": "analog_input", "values": [1, 2, 3, 4]}))
        self.assertIsInstance(driver, AnalogInputDriver)
        driver.open()
        self.assertEqual(driver.read(2)["voltage"], 3.0)
        self.assertEqual([item["voltage"] for item in driver.read_all()["channels"]], [1.0, 2.0, 3.0, 4.0])
        with self.assertRaisesRegex(DriverError, "between 0 and 3"):
            driver.read(4)

    def test_analog_output_validates_without_retaining_state(self) -> None:
        driver = create_driver(server({"kind": "analog_output", "minVoltage": -10, "maxVoltage": 10}))
        self.assertIsInstance(driver, AnalogOutputDriver)
        driver.open()
        first = driver.write(0, 2.5)
        second = driver.write(0, -1.25)
        self.assertEqual(first["voltage"], 2.5)
        self.assertEqual(second["voltage"], -1.25)
        self.assertFalse(hasattr(driver, "outputs"))
        with self.assertRaisesRegex(DriverError, "exactly 4"):
            driver.write_all([1, 2, 3])
        with self.assertRaisesRegex(DriverError, "between -10.0 and 10.0"):
            driver.write(0, 10.1)

    def test_serial_discards_writes_and_returns_fixed_input(self) -> None:
        driver = create_driver(server({"kind": "serial", "inputs": ["ZERO", "一号"]}))
        self.assertIsInstance(driver, SerialDriver)
        driver.open()
        written = driver.write(0, "你好")
        self.assertTrue(written["discarded"])
        self.assertEqual(written["bytesWritten"], len("你好".encode("utf-8")))
        self.assertEqual(driver.read(1)["data"], "一号")
        with self.assertRaisesRegex(DriverError, "between 0 and 1"):
            driver.read(2)

    def test_closed_driver_rejects_operations(self) -> None:
        driver = create_driver(server({"kind": "analog_input", "values": [1, 2, 3, 4]}))
        with self.assertRaisesRegex(DriverError, "not open"):
            assert isinstance(driver, AnalogInputDriver)
            driver.read(0)


if __name__ == "__main__":
    unittest.main()

