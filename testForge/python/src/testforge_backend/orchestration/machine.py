from __future__ import annotations

from typing import Any

from testforge_backend.compat import clone

Json = dict[str, Any]


class RunMachine:
    def __init__(self, run_id: str, phase: str, context: Json, persisted: Any = None) -> None:
        self.value = "running"
        self.context: Json = {"runId": run_id, "phase": phase, "workflowContext": clone(context)}
        if persisted is not None:
            self.value = persisted["value"]
            self.context = clone(persisted["context"])

    @property
    def status(self) -> str:
        return "active" if self.value in {"running", "cancelling"} else "done"

    def checkpoint(self, phase: str, context: Json) -> None:
        if self.status == "active":
            self.context.update(phase=phase, workflowContext=clone(context))

    def send(self, event: str, *, message: str | None = None) -> None:
        transitions = {
            "CANCEL": "cancelling",
            "PASS": "passed",
            "FAIL": "failed",
            "COMPLETE_CANCEL": "cancelled",
            "INTERRUPT": "interrupted",
        }
        allowed = (
            {"CANCEL", "PASS", "FAIL", "COMPLETE_CANCEL", "INTERRUPT"}
            if self.value == "running"
            else {"COMPLETE_CANCEL", "FAIL", "INTERRUPT"}
            if self.value == "cancelling"
            else set()
        )
        if event in allowed:
            self.value = transitions[event]
            if message is not None:
                self.context["message"] = message

    def persisted_snapshot(self) -> Json:
        return {
            "status": self.status,
            "value": self.value,
            "historyValue": {},
            "context": clone(self.context),
            "children": {},
        }


class NodeMachine:
    def __init__(self) -> None:
        self.value = "pending"

    def send(self, event: str) -> None:
        states = {
            "pending": {"START": "running", "SKIP": "skipped", "CANCEL": "cancelled"},
            "running": {
                "WAIT_OPERATOR": "waiting_operator",
                "PASS": "passed",
                "FAIL": "failed",
                "CANCEL": "cancelled",
            },
            "waiting_operator": {"PASS": "passed", "FAIL": "failed", "CANCEL": "cancelled"},
        }
        self.value = states.get(self.value, {}).get(event, self.value)
