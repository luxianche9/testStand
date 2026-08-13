from __future__ import annotations

import base64
import threading
from typing import Any

from testforge_runtime.config import ServerConfig
from testforge_runtime.contract import HardwareState


class DriverError(Exception):
    def __init__(self, message: str, category: str = "internal", retryable: bool = False, details: Any = None) -> None:
        super().__init__(message)
        self.category = category
        self.retryable = retryable
        self.details = details


class VisaScpiDriver:
    """Single VISA resource, single session, single hardware.

    Subclass this when the instrument needs typed tools. Keep raw SCPI tools for bring-up
    and diagnostics, then expose stable domain operations to AI clients.
    """

    def __init__(self, config: ServerConfig) -> None:
        self.config = config
        self.hardware_id = config.hardwareId
        self._lock = threading.RLock()
        self._rm: Any = None
        self._resource: Any = None
        self._state: HardwareState = "closed"
        self._health = "Not opened"
        self._last_error: DriverError | None = None
        self._simulated_responses = dict(config.driver.get("simulatedResponses", {"*IDN?": "TESTFORGE,SIMULATED,0,0.1"}))

    @property
    def state(self) -> HardwareState:
        return self._state

    @property
    def health(self) -> str:
        return self._health

    @property
    def last_error(self) -> DriverError | None:
        return self._last_error

    @property
    def loaded(self) -> bool:
        return self.config.simulate or self._rm is not None

    @property
    def driver_version(self) -> str | None:
        return self.config.driver.get("backend")

    @property
    def serial_number(self) -> str | None:
        return None

    def open(self) -> None:
        with self._lock:
            if self._state == "open":
                return
            self._state = "initializing"
            if self.config.simulate:
                self._state = "open"
                self._health = "OK (simulated)"
                return
            resource_name = str(self.config.driver.get("resource", "")).strip()
            if not resource_name:
                raise DriverError("driver.resource is required", "invalid_argument")
            try:
                import pyvisa
                self._rm = pyvisa.ResourceManager(self.config.driver.get("backend") or None)
                self._resource = self._rm.open_resource(resource_name)
                self._resource.timeout = int(self.config.driver.get("timeoutMs", 10_000))
                self._resource.read_termination = self.config.driver.get("readTermination", "\n")
                self._resource.write_termination = self.config.driver.get("writeTermination", "\n")
                identity = str(self._resource.query("*IDN?")).strip()
                expected = str(self.config.driver.get("idnContains", "")).strip()
                if expected and expected.lower() not in identity.lower():
                    raise DriverError(f"Unexpected *IDN? response: {identity}", "device_unreachable")
                self._health = identity
                self._state = "open"
            except DriverError:
                self._state = "unreachable"
                raise
            except Exception as exc:
                self._state = "unreachable"
                raise DriverError(str(exc), "device_unreachable", retryable=True) from exc

    def close(self) -> None:
        with self._lock:
            self._state = "closing"
            if self._resource is not None:
                self._resource.close()
            if self._rm is not None:
                self._rm.close()
            self._resource = None
            self._rm = None
            self._state = "closed"
            self._health = "Closed"

    def shutdown(self) -> None:
        self.close()

    def safe_stop(self) -> str:
        commands = tuple(self.config.driver.get("safeStopCommands", ("*CLS",)))
        for command in commands:
            self.write(str(command))
        return f"Applied {len(commands)} safe-stop command(s)"

    def write(self, command: str) -> dict[str, Any]:
        with self._lock:
            self._require_open()
            if not self.config.simulate:
                self._resource.write(command)
            return {"command": command, "simulated": self.config.simulate}

    def query(self, command: str) -> dict[str, Any]:
        with self._lock:
            self._require_open()
            response = str(self._simulated_responses.get(command, "0")) if self.config.simulate else str(self._resource.query(command)).rstrip()
            return {"command": command, "response": response, "simulated": self.config.simulate}

    def query_binary(self, command: str, datatype: str = "B", max_bytes: int = 1_048_576) -> dict[str, Any]:
        with self._lock:
            self._require_open()
            raw = bytes(str(self._simulated_responses.get(command, "")), "utf-8") if self.config.simulate else bytes(self._resource.query_binary_values(command, datatype=datatype, container=bytearray))
            if len(raw) > max_bytes:
                raise DriverError(f"Binary response is {len(raw)} bytes; limit is {max_bytes}. Add an MCP Resource for large captures.", "response_too_large")
            return {"command": command, "bytes": len(raw), "base64": base64.b64encode(raw).decode("ascii"), "simulated": self.config.simulate}

    def _require_open(self) -> None:
        if self._state != "open":
            raise DriverError(f"VISA resource is not open: {self._state}", "device_unreachable")
