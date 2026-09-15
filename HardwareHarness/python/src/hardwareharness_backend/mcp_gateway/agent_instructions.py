"""Shared release instructions, bundled for both MCP and the desktop agent."""

from importlib.resources import files

AGENT_INSTRUCTIONS = (
    files("hardwareharness_backend.mcp_gateway")
    .joinpath("agent-instructions.md")
    .read_text(encoding="utf-8")
    .strip()
)
