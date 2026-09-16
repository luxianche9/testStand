"""Redact credentials before gateway responses leave the backend."""

from typing import Any

_PRIVATE = {"authorization", "password", "secret", "token", "accesstoken", "bearertoken"}


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): "[REDACTED]" if str(key).lower() in _PRIVATE else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value
