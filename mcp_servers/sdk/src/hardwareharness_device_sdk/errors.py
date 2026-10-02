"""Typed device failures mapped onto the public error envelope."""

from __future__ import annotations

from typing import Any

INVALID_ARGUMENT = "invalid_argument"
DEVICE_ERROR = "device_error"
DEVICE_UNREACHABLE = "device_unreachable"
SERVICE_UNAVAILABLE = "service_unavailable"
NOT_CONFIGURED = "not_configured"
INVALID_RESPONSE = "invalid_response"
NOT_SUPPORTED = "not_supported"
INTERNAL = "internal"
BUSY = "busy"
"""Another holder leases the hardware; retry after it releases (see error.details.expiresAt)."""

RETRYABLE_CATEGORIES = frozenset({DEVICE_UNREACHABLE, SERVICE_UNAVAILABLE})


class DeviceError(RuntimeError):
    """Expected failure raised by adapters and drivers.

    ``details`` should carry partial effects (for example the channels a safe
    state could not reach) so callers never assume a failed write had no effect.
    """

    def __init__(self, message: str, *, category: str = DEVICE_ERROR, details: Any = None) -> None:
        super().__init__(message)
        self.category = category
        self.details = details


AdapterError = DeviceError
