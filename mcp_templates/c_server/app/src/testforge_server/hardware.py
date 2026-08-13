from __future__ import annotations

from typing import Any

from testforge_runtime.config import ServerConfig
from testforge_runtime.contract import ActionSummary
from testforge_server.driver import CSdkDriver, DriverError


class HardwareDriver(CSdkDriver):
    """Replace this class with calls into the vendor DLL or a C++ bridge executable."""

    capabilities = ("template_io",)
    actions = (
        ActionSummary(name="read_status", kind="hardware", description="Read a representative device status."),
        ActionSummary(name="set_output", kind="hardware", description="Write a representative output value."),
    )

    def __init__(self, config: ServerConfig) -> None:
        super().__init__(config)
        self._value = 0.0

    def _open_handle(self) -> Any:
        if self.config.simulate:
            return object()
        raise DriverError("Implement _open_handle with the vendor C/C++ SDK", "device_unreachable")

    def _close_handle(self) -> None:
        return None

    def safe_stop(self) -> str:
        self._value = float(self.config.driver.get("safeValue", 0.0))
        return f"Output moved to safe value {self._value}"

    def read_status(self) -> dict[str, Any]:
        return {"value": self._value, "simulated": self.config.simulate}

    def set_output(self, value: float) -> dict[str, Any]:
        self._value = float(value)
        return {"value": self._value, "simulated": self.config.simulate}
