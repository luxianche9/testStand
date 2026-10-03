from typing import Any

from hardwareharness_backend.contracts.validation import literal, obj, parse_record
from hardwareharness_backend.util import Record

agent_kind_schema = literal("codex")
agent_kind_input_schema = obj({"id": agent_kind_schema}, strict=True)
CAPABILITIES = (
    "system.read",
    "system.manage",
    "agents.manage",
    "devices.read",
    "devices.manageServers",
    "hardware.read",
    "hardware.manage",
    "hardware.executeTools",
    "hardware.releaseAdapters",
    "projects.read",
    "projects.manage",
    "wiring.read",
    "wiring.request",
    "wiring.confirm",
    "references.read",
    "references.manage",
    "testing.read",
    "testing.manage",
    "testing.execute",
    "testing.judge",
)


def parse_agent_kind_input(value: Any) -> Record:
    return parse_record(agent_kind_input_schema, value)
