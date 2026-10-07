"""How a stream is driven: the device tool that writes it, declared next to the stream.

A stream is a signal; a writable signal names the ``actuate`` tool that changes it and how the
tool's arguments are filled. ``/device.streams[].control`` lists one entry per way of writing::

    BitsStream("relay", ..., control=[
        control("setBit", "set_relay", channel=BIT, closed=VALUE),
        control("setMask", "set_bank", mask=VALUE)])

Each entry is ``{action, tool, args}``. ``tool`` is the tool's full name (with the device
prefix); ``args`` are fixed values plus placeholders ``{"$": name}`` that the caller fills.
Which placeholders an action takes depends on the stream type (:data:`ACTIONS`). The stream
itself stays read-only: what it shows is what the device reports, never the command sent.
Streams and tools are never related to pins.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

ACTIONS: dict[str, tuple[str, frozenset[str]]] = {
    "set": ("scalar", frozenset({"value"})),
    "setBit": ("bits", frozenset({"bit", "value"})),
    "setMask": ("bits", frozenset({"value"})),
    "sendText": ("bytes", frozenset({"text"})),
    "sendHex": ("bytes", frozenset({"hex"})),
    "sendFrame": ("frames", frozenset({"id", "hex"})),
}
"""Action -> (stream type, placeholders it fills). ``setBit`` fills a bit index and a boolean;
``setMask`` and ``set`` a number; ``sendHex`` lowercase hex without separators."""


@dataclass(frozen=True)
class Placeholder:
    """A tool argument the caller fills when writing the stream."""

    name: str

    def describe(self) -> dict[str, str]:
        return {"$": self.name}


VALUE = Placeholder("value")
BIT = Placeholder("bit")
TEXT = Placeholder("text")
HEX = Placeholder("hex")
FRAME_ID = Placeholder("id")


@dataclass(frozen=True)
class StreamControl:
    action: str
    tool: str
    """The tool's name as written in the adapter (without the device prefix)."""
    args: Mapping[str, Any] = field(default_factory=dict)

    def placeholders(self) -> set[str]:
        return {value.name for value in self.args.values() if isinstance(value, Placeholder)}

    def check(self, stream_id: str, stream_type: str) -> None:
        expected = ACTIONS.get(self.action)
        if expected is None:
            raise ValueError(f"{stream_id}: control action must be one of {sorted(ACTIONS)}, got {self.action!r}")
        kind, names = expected
        if stream_type != kind:
            raise ValueError(f"{stream_id}: control action {self.action} writes {kind} streams, not {stream_type}")
        used = [value.name for value in self.args.values() if isinstance(value, Placeholder)]
        if sorted(used) != sorted(names):
            raise ValueError(f"{stream_id}: control {self.action} via {self.tool} must fill {sorted(names)} "
                             f"exactly once, got {sorted(used)}")

    def describe(self, prefix: str = "") -> dict[str, Any]:
        return {
            "action": self.action,
            "tool": f"{prefix}_{self.tool}" if prefix else self.tool,
            "args": {key: value.describe() if isinstance(value, Placeholder) else value
                     for key, value in self.args.items()},
        }


def control(action: str, tool: str, **args: Any) -> StreamControl:
    """One way to write a stream: ``tool`` (adapter tool name) called with ``args``, placeholders filled by the caller."""
    return StreamControl(action, tool, dict(args))
