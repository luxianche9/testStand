"""What a verdict reads: one stream's records, and the key that names a stream.

Shared by the pure judge (domain) and the stream store (resource) so neither depends
on the other.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from hardwareharness_backend.util import Record


def stream_key(hardware_id: str, stream_id: str) -> str:
    return f"{hardware_id}__{stream_id}"


@dataclass
class StreamData:
    """What a verdict may look at: one stream's records in service time, oldest first."""

    stream_type: str
    records: list[Record]
    gaps: list[Record] = field(default_factory=list)
    watermark: float | None = None
    clock: Record = field(default_factory=dict)
    # The stream's ``/device.streams[]`` entry when known (``kind``, ``unit``, ``width`` ...).
    descriptor: Record = field(default_factory=dict)
