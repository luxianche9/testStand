"""Process-local open state for one PCI-6208V card."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


CHANNEL_COUNT = 8
VOLT_MIN = -10.0
VOLT_MAX = 10.0


@dataclass
class CardState:
    open: bool = False
    card_index: int = 0
    handle: Optional[int] = None
    safe_volts: float = 0.0
    # Last written voltage per channel; None means never written this session.
    last_volts: list[Optional[float]] = field(default_factory=lambda: [None] * CHANNEL_COUNT)


STATE = CardState()
