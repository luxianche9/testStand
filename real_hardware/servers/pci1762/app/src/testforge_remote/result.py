"""Uniform tool result shape for this MCP server."""

from __future__ import annotations

from typing import Any


def ok(message: str = "", data: Any = None, *, reachable: bool = True) -> dict[str, Any]:
    return {"ok": True, "reachable": reachable, "message": message, "data": data}


def err(
    message: str,
    *,
    reachable: bool = False,
    data: Any = None,
) -> dict[str, Any]:
    return {"ok": False, "reachable": reachable, "message": message, "data": data}
