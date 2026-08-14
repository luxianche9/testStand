from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

CONTRACT_VERSION = "2.0"
HardwareState = Literal["initializing", "open", "unreachable", "faulted", "closing", "closed"]


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LastError(ContractModel):
    category: str
    message: str
    at: str | None = None


class HardwareSummary(ContractModel):
    hardwareId: str
    manufacturer: str
    model: str
    capabilities: tuple[str, ...]
    state: HardwareState
    health: str
    lastError: LastError | None = None


class ActionSummary(ContractModel):
    name: str
    kind: str
    description: str = ""


class HardwareInfo(ContractModel):
    hardwareId: str
    manufacturer: str
    model: str
    state: HardwareState
    health: str
    driverVersion: str | None = None
    actions: tuple[ActionSummary, ...]
    lastError: LastError | None = None


class ServerInfo(ContractModel):
    serverId: str
    serverVersion: str
    contractVersion: str
    manufacturer: str
    model: str
    hardwareIds: tuple[str, ...]
    driverVersion: str | None = None
    simulated: bool = True


class ToolMeta(ContractModel):
    timestamp: str


class ToolError(ContractModel):
    category: str
    message: str
    retryable: bool = False
    details: Any = None


class Envelope(ContractModel):
    ok: bool
    message: str = ""
    error: ToolError | None = None
    meta: ToolMeta


class ServerInfoResponse(Envelope):
    data: ServerInfo | None = None


class HardwareListResponse(Envelope):
    data: tuple[HardwareSummary, ...] | None = None


class HardwareInfoResponse(Envelope):
    data: HardwareInfo | None = None

