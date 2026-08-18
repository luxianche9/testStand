"""Process-local open state for one CP-118U-I card (P1..P8)."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class CardState:
    open: bool = False
    base_port: int = 3
    port_count: int = 8
    # PComm port numbers currently held open
    ports: list[int] = field(default_factory=list)
    # Explicit board silkscreen channel -> PComm/COM number mapping.
    port_map: dict[int, int] = field(default_factory=dict)
    # Accumulated RX bytes since last clear, keyed by channel 1..8 (board silkscreen)
    rx_buf: dict[int, bytearray] = field(default_factory=dict)


STATE = CardState()
