from __future__ import annotations

import json
import math
import os
from ipaddress import ip_address
from pathlib import Path
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

DEFAULT_AI_VALUES = (1.0, 2.0, 3.0, 4.0)
DEFAULT_SERIAL_INPUTS = ("SIM_PORT0_INPUT", "SIM_PORT1_INPUT")


class AnalogInputConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    kind: Literal["analog_input"]
    min_voltage: float = Field(default=-10.0, alias="minVoltage")
    max_voltage: float = Field(default=10.0, alias="maxVoltage")
    values: tuple[float, ...] = DEFAULT_AI_VALUES

    @model_validator(mode="after")
    def validate_channels(self) -> "AnalogInputConfig":
        _validate_range(self.min_voltage, self.max_voltage)
        if len(self.values) != 4:
            raise ValueError("analog_input.values must contain exactly 4 values")
        for value in self.values:
            _validate_voltage(value, self.min_voltage, self.max_voltage)
        return self


class AnalogOutputConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    kind: Literal["analog_output"]
    min_voltage: float = Field(default=-10.0, alias="minVoltage")
    max_voltage: float = Field(default=10.0, alias="maxVoltage")

    @model_validator(mode="after")
    def validate_range(self) -> "AnalogOutputConfig":
        _validate_range(self.min_voltage, self.max_voltage)
        return self


class SerialConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    kind: Literal["serial"]
    inputs: tuple[str, ...] = DEFAULT_SERIAL_INPUTS

    @model_validator(mode="after")
    def validate_ports(self) -> "SerialConfig":
        if len(self.inputs) != 2:
            raise ValueError("serial.inputs must contain exactly 2 strings")
        if any(not isinstance(value, str) for value in self.inputs):
            raise ValueError("serial.inputs must contain strings")
        return self


DriverConfig = Annotated[
    Union[AnalogInputConfig, AnalogOutputConfig, SerialConfig],
    Field(discriminator="kind"),
]


class ServerConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    server_id: str = Field(alias="serverId", min_length=1)
    hardware_id: str = Field(alias="hardwareId", min_length=1)
    label: str = Field(min_length=1)
    manufacturer: str = Field(default="TestForge", min_length=1)
    model: str = Field(min_length=1)
    server_version: str = Field(default="0.1.0", alias="serverVersion", min_length=1)
    host: str = "127.0.0.1"
    port: int = Field(ge=1, le=65535)
    token: str = Field(min_length=1)
    driver: DriverConfig

    @field_validator("server_id", "hardware_id", "label", "manufacturer", "model", "server_version", "host", "token")
    @classmethod
    def strip_strings(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("value cannot be blank")
        return stripped

    @model_validator(mode="after")
    def require_loopback(self) -> "ServerConfig":
        if not is_loopback(self.host):
            raise ValueError("virtual hardware servers may only bind to a loopback address")
        return self


def load_config(path: str | Path | None = None) -> ServerConfig:
    config_path = Path(path) if path is not None else Path(os.environ.get("TESTFORGE_SIM_CONFIG", "server.json"))
    if not config_path.is_file():
        raise RuntimeError(f"Server configuration not found: {config_path}")
    raw = json.loads(config_path.read_text(encoding="utf-8-sig"))
    if value := os.environ.get("TESTFORGE_SERVER_ID"):
        raw["serverId"] = value
    if value := os.environ.get("TESTFORGE_HARDWARE_ID"):
        raw["hardwareId"] = value
    if value := os.environ.get("TESTFORGE_HOST"):
        raw["host"] = value
    if value := os.environ.get("TESTFORGE_PORT"):
        raw["port"] = int(value)
    if value := os.environ.get("TESTFORGE_MCP_TOKEN"):
        raw["token"] = value
    return ServerConfig.model_validate(raw)


def is_loopback(host: str) -> bool:
    if host.strip().lower() == "localhost":
        return True
    try:
        return ip_address(host.strip()).is_loopback
    except ValueError:
        return False


def _validate_range(minimum: float, maximum: float) -> None:
    if not math.isfinite(minimum) or not math.isfinite(maximum) or minimum >= maximum:
        raise ValueError("voltage range must contain finite minVoltage < maxVoltage")


def _validate_voltage(value: float, minimum: float, maximum: float) -> None:
    if not math.isfinite(value) or value < minimum or value > maximum:
        raise ValueError(f"voltage must be finite and between {minimum} and {maximum}")

