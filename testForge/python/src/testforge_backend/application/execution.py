from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import cmp_to_key

from testforge_backend.compat import clone, utf16_compare
from testforge_backend.compat.collation import locale_compare
from testforge_backend.contracts.errors import app_error

from .authorization import Json


class ExecutionLease:
    def __init__(self, release: Callable[[], None]) -> None:
        self._release = release
        self._released = False

    def release(self) -> None:
        if not self._released:
            self._released = True
            self._release()


@dataclass
class _Holder:
    activity: Json
    keys: list[tuple[str, int]]


def _key(activity: Json) -> str:
    return (
        f"manual:{activity['hardwareId']}:{activity['startedAt']}"
        if activity["state"] == "manual"
        else f"run:{activity['runId']}"
    )


def _hardware_ids(activity: Json) -> list[str]:
    return (
        [activity["hardwareId"]] if activity["state"] == "manual" else list(activity["hardwareIds"])
    )


class ExecutionCoordinator:
    def __init__(self) -> None:
        self.holders: dict[int, _Holder] = {}
        self.hardware_holders: dict[str, tuple[int, int]] = {}
        self.generations: dict[str, int] = {}
        self.next_lease_id = 0
        self.notifier: Callable[[Json], None] | None = None

    def current(self) -> Json:
        def compare(a: Json, b: Json) -> int:
            return locale_compare(a["startedAt"], b["startedAt"]) or locale_compare(
                _key(a), _key(b)
            )

        activities = sorted(
            [holder.activity for holder in self.holders.values()], key=cmp_to_key(compare)
        )
        if not activities:
            return {"state": "idle"}
        representative = clone(
            next((activity for activity in activities if activity["state"] == "run"), activities[0])
        )
        if len(activities) > 1:
            representative["activities"] = clone(activities)
        return representative

    def set_notifier(self, notifier: Callable[[Json], None]) -> None:
        self.notifier = notifier

    def is_hardware_busy(self, hardware_id: str) -> bool:
        return any(
            hardware_id in _hardware_ids(holder.activity) for holder in self.holders.values()
        )

    def acquire(self, activity: Json) -> ExecutionLease:
        normalized = clone(activity)
        if normalized["state"] != "manual":
            normalized["hardwareIds"] = sorted(
                set(normalized["hardwareIds"]), key=cmp_to_key(utf16_compare)
            )
        hardware_ids = _hardware_ids(normalized)
        conflicts = [
            (hardware_id, self.holders[self.hardware_holders[hardware_id][0]].activity)
            for hardware_id in hardware_ids
            if hardware_id in self.hardware_holders
        ]
        if conflicts:
            ids = sorted(
                {hardware_id for hardware_id, _ in conflicts}, key=cmp_to_key(utf16_compare)
            )
            activities = list({_key(item): clone(item) for _, item in conflicts}.values())
            raise app_error(
                "conflict",
                f"Hardware execution is already active for {', '.join(ids)}",
                {"hardwareIds": ids, "activities": activities},
            )
        self.next_lease_id += 1
        lease_id = self.next_lease_id
        keys: list[tuple[str, int]] = []
        for hardware_id in hardware_ids:
            generation = self.generations.get(hardware_id, 0) + 1
            self.generations[hardware_id] = generation
            keys.append((hardware_id, generation))
        holder = _Holder(normalized, keys)
        self.holders[lease_id] = holder
        for hardware_id, generation in keys:
            self.hardware_holders[hardware_id] = (lease_id, generation)
        self._notify()

        def release() -> None:
            if self.holders.get(lease_id) is not holder:
                return
            del self.holders[lease_id]
            for hardware_id, generation in keys:
                if self.hardware_holders.get(hardware_id) == (lease_id, generation):
                    del self.hardware_holders[hardware_id]
            self._notify()

        return ExecutionLease(release)

    def _notify(self) -> None:
        if self.notifier:
            self.notifier(self.current())
