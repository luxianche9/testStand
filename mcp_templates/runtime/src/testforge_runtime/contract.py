from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

CONTRACT_VERSION = "2.0"
HardwareState = Literal["initializing", "open", "unreachable", "faulted", "closing", "closed"]


class LastError(BaseModel):
    category: str
    message: str
    at: str | None = None


class HardwareSummary(BaseModel):
    hardwareId: str
    manufacturer: str
    model: str
    capabilities: tuple[str, ...]
    state: HardwareState
    health: str
    lastError: LastError | None = None


class ActionSummary(BaseModel):
    name: str
    kind: str
    description: str = ""


class HardwareInfo(BaseModel):
    hardwareId: str
    manufacturer: str
    model: str
    serialNumber: str | None = None
    state: HardwareState
    health: str
    driverVersion: str | None = None
    actions: tuple[ActionSummary, ...]
    lastError: LastError | None = None


class ServerInfo(BaseModel):
    serverId: str
    serverVersion: str
    contractVersion: str
    manufacturer: str
    model: str
    hardwareIds: tuple[str, ...]
    driverVersion: str | None = None
    simulated: bool


class Health(BaseModel):
    healthy: bool
    driverLoaded: bool
    hardwareState: HardwareState
    detail: str = ""


class SafeStopResult(BaseModel):
    hardwareId: str
    applied: bool
    state: HardwareState
    detail: str = ""


class ToolMeta(BaseModel):
    timestamp: str


class ToolError(BaseModel):
    category: str
    message: str
    retryable: bool = False
    details: Any = None


class _Envelope(BaseModel):
    ok: bool
    message: str = ""
    error: ToolError | None = None
    meta: ToolMeta


class ServerInfoResponse(_Envelope):
    data: ServerInfo | None = None


class HealthResponse(_Envelope):
    data: Health | None = None


class HardwareListResponse(_Envelope):
    data: tuple[HardwareSummary, ...] | None = None


class HardwareInfoResponse(_Envelope):
    data: HardwareInfo | None = None

class SafeStopResponse(_Envelope):
    data: tuple[SafeStopResult, ...] | None = None
