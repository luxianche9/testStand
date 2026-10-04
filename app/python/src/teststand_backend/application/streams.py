"""Stream operations: what a service streams, recorded windows and ad-hoc verdicts.

Streams are read-only; nothing here drives hardware. Controls stay MCP tool calls.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from teststand_backend.contracts.errors import app_error
from teststand_backend.contracts.operations import Tool, operation
from teststand_backend.contracts.validation import (
    array,
    number,
    obj,
    record,
    string,
    unknown,
)
from teststand_backend.streams.judge import MIN_SAMPLES

from .authorization import Authorizer, Json

if TYPE_CHECKING:
    from teststand_backend.devices import DeviceService
    from teststand_backend.streams.live import LiveStreams
    from teststand_backend.testing.engine import TestEngine


class StreamsApplication:
    def __init__(
        self,
        authorizer: Authorizer,
        devices: DeviceService,
        live: LiveStreams | None = None,
        *,
        runs: TestEngine | None = None,
    ) -> None:
        self.authorizer, self.devices, self._live = authorizer, devices, live
        self.runs = runs

    @property
    def live(self) -> LiveStreams:
        if self._live is None:
            raise app_error("unavailable", "Live streams are not available")
        return self._live

    @operation(
        "streams.listStreams",
        capability="hardware.read",
        risk="read",
        profiles=("plan", "explore"),
        idempotency="natural",
    )
    async def list_streams(self, context: Json, hardware_id: str) -> list[Json]:
        return await self.devices.list_streams(hardware_id)

    @operation(
        "streams.window",
        capability="testing.read",
        risk="read",
        profiles=("run",),
        idempotency="natural",
    )
    def window(
        self, context: Json, run_id: str, keys: list[str], t0: float, t1: float, width: int
    ) -> Json:
        """A run recording over ``[t0, t1]``, min/max downsampled to ``width`` pixel columns
        (design doc 5.9.3); the live view is ``GET /api/live``."""
        if self.runs is None:
            raise app_error("unavailable", "Run recordings are not available")
        result: Json = self.runs.stream_window(run_id, keys, t0, t1, width)
        return result

    @operation(
        "streams.observe",
        capability="hardware.read",
        risk="read",
        profiles=("plan", "explore"),
        idempotency="natural",
    )
    async def observe(
        self,
        context: Json,
        hardware_id: str,
        stream_id: str,
        window_ms: float,
        assertions: list[Json] | None = None,
        min_samples: int = MIN_SAMPLES,
    ) -> Json:
        return await self.live.observe(
            hardware_id,
            stream_id,
            window_ms=window_ms,
            assertions=assertions,
            min_samples=min_samples,
        )

    @operation(
        "streams.expect",
        capability="hardware.read",
        risk="read",
        profiles=("plan", "explore"),
        idempotency="natural",
    )
    async def expect(
        self, context: Json, hardware_id: str, stream_id: str, within_ms: float, match: Json
    ) -> Json:
        return await self.live.expect(hardware_id, stream_id, within_ms=within_ms, match=match)


_STREAM = {
    "hardwareId": string(1).describe("Concrete managed testStand hardware id."),
    "streamId": string(1).describe("Stream id from list_device_streams."),
}
_ANY_LIST = {"type": "array", "items": {"type": "object"}}
_PROBE_OUTPUT = {
    "type": "object",
    "properties": {
        "key": {"type": "string"},
        "window": {"type": ["object", "null"]},
        "verdict": {"type": ["object", "null"]},
        "data": {"type": "object"},
    },
    "required": ["key", "window", "verdict", "data"],
    "additionalProperties": True,
}

STREAM_TOOLS = [
    Tool(
        "list_device_streams",
        "List the read-only data streams one hardware service publishes, as {id, type}.",
        obj({"hardwareId": _STREAM["hardwareId"]}, strict=True),
        _ANY_LIST,
        operation="streams.listStreams",
        fields=("hardwareId",),
    ),
    Tool(
        "observe_stream",
        "Record a stream for windowMs starting now and return what was seen; with "
        "assertions, also judge them exactly like an Observe step. Assertion: "
        "{metric, op, expected?, tolerance?} with metric per stream type (scalar: "
        "mean/min/max/p2p/std/first/last/count; bits: bitN.first/last/edges; bytes: "
        "rx.text/rx.hex/count; ...) and op lt/le/gt/ge/eq/ne/within/outside/matches/contains.",
        obj(
            {
                **_STREAM,
                "windowMs": number(1, 60000).describe("Window length from now, ms."),
                "assertions": array(record(unknown()))
                .default([])
                .describe("Optional Observe assertions."),
                "minSamples": number(1, integer=True)
                .default(MIN_SAMPLES)
                .describe("Fewer samples in the window is Inconclusive."),
            },
            strict=True,
        ),
        _PROBE_OUTPUT,
        operation="streams.observe",
        fields=("hardwareId", "streamId", "windowMs", "assertions", "minSamples"),
    ),
    Tool(
        "expect_stream",
        "Wait up to withinMs from now for one record matching match, judged exactly like an "
        "Expect step. bytes: {dir: rx|tx, pattern (regex) | contains | hex}; frame: "
        "{dir?, id?, data?}; event: {type?, path?, op?, expected?}. Trigger the event "
        "with a tool call right after starting this call.",
        obj(
            {
                **_STREAM,
                "withinMs": number(1, 60000).describe("Deadline from now, ms."),
                "match": record(unknown()).describe("Record match for the stream type."),
            },
            strict=True,
        ),
        _PROBE_OUTPUT,
        operation="streams.expect",
        fields=("hardwareId", "streamId", "withinMs", "match"),
    ),
]
