from __future__ import annotations

import math
from typing import Any

from testforge_sim_hardware.config import AnalogInputConfig, AnalogOutputConfig, SerialConfig, ServerConfig
from testforge_sim_hardware.contract import ActionSummary, HardwareState, LastError


class DriverError(Exception):
    def __init__(self, message: str, category: str = "internal", retryable: bool = False, details: Any = None) -> None:
        super().__init__(message)
        self.category = category
        self.retryable = retryable
        self.details = details


class BaseDriver:
    capabilities: tuple[str, ...] = ()
    actions: tuple[ActionSummary, ...] = ()
    driver_version = "sim-0.1.0"

    def __init__(self, config: ServerConfig) -> None:
        self.config = config
        self._state: HardwareState = "closed"
        self._health = "Not opened"
        self._last_error: LastError | None = None

    @property
    def state(self) -> HardwareState:
        return self._state

    @property
    def health(self) -> str:
        return self._health

    @property
    def last_error(self) -> LastError | None:
        return self._last_error

    def open(self) -> None:
        self._state = "open"
        self._health = "OK (simulated)"
        self._last_error = None

    def safe_stop(self) -> str:
        return "Virtual hardware is safe"

    def shutdown(self) -> None:
        self._state = "closed"
        self._health = "Closed"

    def require_open(self) -> None:
        if self._state != "open":
            raise DriverError("Virtual hardware is not open", "device_unreachable", retryable=True)

    @staticmethod
    def require_index(value: int, count: int, name: str) -> None:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value >= count:
            raise DriverError(f"{name} must be an integer between 0 and {count - 1}", "invalid_argument")


class AnalogInputDriver(BaseDriver):
    capabilities = ("read_analog_input", "read_all_analog_inputs")
    actions = (
        ActionSummary(name="read_analog_input", kind="hardware", description="Read one fixed simulated analog input voltage."),
        ActionSummary(name="read_all_analog_inputs", kind="hardware", description="Read all four fixed simulated analog input voltages."),
    )

    @property
    def settings(self) -> AnalogInputConfig:
        assert isinstance(self.config.driver, AnalogInputConfig)
        return self.config.driver

    def read(self, channel: int) -> dict[str, Any]:
        self.require_open()
        self.require_index(channel, 4, "channel")
        return {
            "channel": channel,
            "voltage": self.settings.values[channel],
            "unit": "V",
            "simulated": True,
        }

    def read_all(self) -> dict[str, Any]:
        self.require_open()
        return {"channels": [self.read(channel) for channel in range(4)], "simulated": True}


class AnalogOutputDriver(BaseDriver):
    capabilities = ("write_analog_output", "write_all_analog_outputs")
    actions = (
        ActionSummary(name="write_analog_output", kind="hardware", description="Validate and acknowledge one simulated analog output write."),
        ActionSummary(name="write_all_analog_outputs", kind="hardware", description="Validate and acknowledge four simulated analog output writes."),
    )

    @property
    def settings(self) -> AnalogOutputConfig:
        assert isinstance(self.config.driver, AnalogOutputConfig)
        return self.config.driver

    def write(self, channel: int, voltage: float) -> dict[str, Any]:
        self.require_open()
        self.require_index(channel, 4, "channel")
        value = self.validate_voltage(voltage)
        return {
            "channel": channel,
            "voltage": value,
            "unit": "V",
            "accepted": True,
            "simulated": True,
        }

    def write_all(self, voltages: list[float]) -> dict[str, Any]:
        self.require_open()
        if len(voltages) != 4:
            raise DriverError("voltages must contain exactly 4 values", "invalid_argument")
        values = [self.validate_voltage(value) for value in voltages]
        return {
            "channels": [
                {"channel": channel, "voltage": value, "unit": "V", "accepted": True}
                for channel, value in enumerate(values)
            ],
            "accepted": True,
            "simulated": True,
        }

    def validate_voltage(self, voltage: float) -> float:
        if isinstance(voltage, bool) or not isinstance(voltage, (int, float)):
            raise DriverError("voltage must be a number", "invalid_argument")
        value = float(voltage)
        if not math.isfinite(value) or value < self.settings.min_voltage or value > self.settings.max_voltage:
            raise DriverError(
                f"voltage must be finite and between {self.settings.min_voltage} and {self.settings.max_voltage}",
                "invalid_argument",
            )
        return value


class SerialDriver(BaseDriver):
    capabilities = ("write_serial", "read_serial")
    actions = (
        ActionSummary(name="write_serial", kind="hardware", description="Accept UTF-8 data and discard it."),
        ActionSummary(name="read_serial", kind="hardware", description="Return a fixed simulated UTF-8 input string."),
    )

    @property
    def settings(self) -> SerialConfig:
        assert isinstance(self.config.driver, SerialConfig)
        return self.config.driver

    def write(self, port: int, data: str) -> dict[str, Any]:
        self.require_open()
        self.require_index(port, 2, "port")
        if not isinstance(data, str):
            raise DriverError("data must be a string", "invalid_argument")
        return {
            "port": port,
            "bytesWritten": len(data.encode("utf-8")),
            "encoding": "utf-8",
            "discarded": True,
            "simulated": True,
        }

    def read(self, port: int) -> dict[str, Any]:
        self.require_open()
        self.require_index(port, 2, "port")
        data = self.settings.inputs[port]
        return {
            "port": port,
            "data": data,
            "bytesRead": len(data.encode("utf-8")),
            "encoding": "utf-8",
            "simulated": True,
        }


def create_driver(config: ServerConfig) -> BaseDriver:
    if isinstance(config.driver, AnalogInputConfig):
        return AnalogInputDriver(config)
    if isinstance(config.driver, AnalogOutputConfig):
        return AnalogOutputDriver(config)
    if isinstance(config.driver, SerialConfig):
        return SerialDriver(config)
    raise TypeError(f"Unsupported virtual hardware driver: {type(config.driver).__name__}")

