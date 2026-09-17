from __future__ import annotations

from importlib.metadata import entry_points
from typing import Any, Protocol

Record = dict[str, Any]


class TestExecutionContext(Protocol):
    async def invoke_device(
        self, hardware_id: str, tool_name: str, arguments: Record, timeout_ms: int
    ) -> Any: ...
    def publish_result(self, result: Record) -> None: ...
    async def checkpoint(self) -> None: ...


class TestStepPlugin(Protocol):
    type_name: str
    settings_schema: Record
    output_schema: Record

    def validate(self, step: Record) -> list[Record]: ...
    async def prepare(self, context: TestExecutionContext, step: Record) -> None: ...
    async def run(self, context: TestExecutionContext, step: Record) -> Any: ...
    async def cleanup(self, context: TestExecutionContext, step: Record) -> None: ...


class ResultListenerPlugin(Protocol):
    def on_event(self, event: Record) -> None: ...


def load_plugins(group: str) -> list[Any]:
    return [point.load()() for point in entry_points().select(group=group)]
