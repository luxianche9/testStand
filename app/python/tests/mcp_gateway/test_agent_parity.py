"""The Agent can do what the operator does in the app, except the operator's own work."""

from teststand_backend.application import OPERATIONS
from teststand_backend.mcp_gateway.tool_registry import BUILTIN_TOOLS, NOT_GENERATED

# Operations only a person performs, each for a reason the Agent cannot stand in for.
HUMAN_ONLY = {
    # Installing plugins and moving whole bundles between benches is bench administration.
    "devices.inspectPackage",
    "devices.addDevice",
    "devices.exportBundle",
    "devices.importBundle",
    "devices.inspectBundle",
    # The desktop's project chooser; the Agent opens folders with open_project.
    "projects.inspectFolder",
    "projects.leaveProject",
    "projects.forgetRecent",
    # Wiring is physical: only the operator edits the pin list and answers wiring tasks. The
    # Agent asks with request_wiring, which waits for the answer itself.
    "wiring.updateDocument",
    "wiring.requestTask",
    "wiring.completeTask",
    "wiring.cancelTask",
    "wiring.getTask",
    "wiring.listTasks",
    # The canvas saves whole documents; the Agent edits by apply_signal_view_operations.
    "signals.updateDocument",
    # Manual device calls are the remote device tools themselves for the Agent.
    "manual.invokeTool",
    # A person judges a manual check and answers confirmations.
    "testing.answerManualCheck",
    "system.listConfirmations",
    "system.answerConfirmation",
    # The desktop's status bar; the Agent reads get_agent_context.
    "system.dashboard",
}


def test_every_operation_is_an_agent_tool_or_human_only() -> None:
    curated = {tool.operation for tool in BUILTIN_TOOLS if tool.operation}
    agent = {
        name
        for name, definition in OPERATIONS.items()
        if definition.spec.profiles or name in curated or name in NOT_GENERATED
    }
    missing = set(OPERATIONS) - agent - HUMAN_ONLY
    assert not missing, f"Give these operations an Agent tool or list them as human-only: {missing}"
    assert not HUMAN_ONLY & agent, "An operation listed human-only is an Agent tool"
    assert HUMAN_ONLY <= set(OPERATIONS)
