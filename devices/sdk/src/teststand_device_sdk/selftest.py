"""Plugin self-test: checks a user runs on the bench to see the plugin and the card agree.

A device that overrides :meth:`Device.self_test` gets the builtin tool ``self_test``. It runs
under the device lock with the hardware open and returns ``{passed, checks, durationMs}``; each
check names what it looked at, what it measured, what was expected and whether they agree.

A self-test reads only: identity, driver version, channel counts, register readback, the rate a
sampled stream actually reaches, readings that must lie in range. It never drives an external
output — a value written to a register the card reads back is fine, a relay that closes is not.
Checks that need a loopback harness belong in the plugin's acceptance procedure instead.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Check:
    """One self-test check. ``measured``/``expected`` are what an engineer would compare."""

    name: str
    passed: bool
    measured: Any = None
    expected: Any = None
    detail: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def as_record(self) -> dict[str, Any]:
        record = {key: value for key, value in asdict(self).items() if value not in (None, "", {})}
        record["passed"] = self.passed
        return record


def check_equal(name: str, measured: Any, expected: Any, detail: str = "") -> Check:
    return Check(name, measured == expected, measured, expected, detail)


def check_range(name: str, measured: float | None, low: float, high: float, unit: str = "", detail: str = "") -> Check:
    suffix = f" {unit}" if unit else ""
    passed = measured is not None and low <= measured <= high
    return Check(name, passed, measured, f"{low}..{high}{suffix}", detail)
