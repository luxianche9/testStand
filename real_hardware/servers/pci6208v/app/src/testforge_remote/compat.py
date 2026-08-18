"""Compatibility shim for the four adapter modules created against MCP SDK v2."""

from __future__ import annotations

import sys
import types

from mcp.server.fastmcp import FastMCP


class LegacyMCPServer(FastMCP):
    def __init__(self, *, name: str, version: str | None = None, instructions: str | None = None, **kwargs):
        del version
        super().__init__(name=name, instructions=instructions, **kwargs)


def install() -> None:
    if "mcp.server.mcpserver" in sys.modules:
        return
    module = types.ModuleType("mcp.server.mcpserver")
    module.MCPServer = LegacyMCPServer
    sys.modules[module.__name__] = module
