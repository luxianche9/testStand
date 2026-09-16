from typing import Any

from hardwareharness_backend.compat import Record
from hardwareharness_backend.contracts.validation import literal, obj, parse_record

agent_kind_schema = literal("codex")
agent_kind_input_schema = obj({"id": agent_kind_schema}, strict=True)
CAPABILITIES = (
    "system.read",
    "system.manage",
    "agents.manage",
    "devices.read",
    "devices.manageComputers",
    "devices.manageServers",
    "devices.controlServers",
    "devices.forceStopServers",
    "devices.ssh",
    "hardware.read",
    "hardware.manage",
    "hardware.executeTools",
    "projects.read",
    "projects.manage",
    "wiring.read",
    "wiring.request",
    "wiring.confirm",
    "references.read",
    "references.manage",
)


def parse_agent_kind_input(value: Any) -> Record:
    return parse_record(agent_kind_input_schema, value)
