"""Shared release instructions, bundled for both MCP and the desktop agent."""

from importlib.resources import files

AGENT_INSTRUCTIONS = (
    files("teststand_backend.mcp_gateway")
    .joinpath("agent-instructions.md")
    .read_text(encoding="utf-8")
    .strip()
)
