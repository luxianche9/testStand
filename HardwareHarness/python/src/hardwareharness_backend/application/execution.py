from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.util import clone

from .authorization import Json


class ExecutionHandle:
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
    if activity.get("state") == "run":
        return f"run:{activity.get('runId', '')}:{activity['startedAt']}"
    return f"manual:{activity['hardwareId']}:{activity['startedAt']}"


def _hardware_ids(activity: Json) -> list[str]:
    if activity.get("state") == "run":
        return list(dict.fromkeys(activity.get("hardwareIds", [])))
    return [activity["hardwareId"]]


class ExecutionCoordinator:
    def __init__(self) -> None:
        self.holders: dict[int, _Holder] = {}
        self.hardware_holders: dict[str, tuple[int, int]] = {}
        self.generations: dict[str, int] = {}
        self.next_handle_id = 0
        self.notifier: Callable[[Json], None] | None = None

    def current(self) -> Json:
        def order(item: Json) -> tuple[str, str]:
            return item["startedAt"], _key(item)

        activities = sorted([holder.activity for holder in self.holders.values()], key=order)
        if not activities:
            return {"state": "idle"}
        representative = clone(activities[0])
        if len(activities) > 1:
            representative["activities"] = clone(activities)
        return representative

    def set_notifier(self, notifier: Callable[[Json], None]) -> None:
        self.notifier = notifier

    def acquire(self, activity: Json) -> ExecutionHandle:
        normalized = clone(activity)
        hardware_ids = _hardware_ids(normalized)
        conflicts = [
            (hardware_id, self.holders[self.hardware_holders[hardware_id][0]].activity)
            for hardware_id in hardware_ids
            if hardware_id in self.hardware_holders
        ]
        if conflicts:
            ids = sorted({hardware_id for hardware_id, _ in conflicts})
            activities = list({_key(item): clone(item) for _, item in conflicts}.values())
            raise app_error(
                "conflict",
                f"Hardware execution is already active for {', '.join(ids)}",
                {"hardwareIds": ids, "activities": activities},
            )
        self.next_handle_id += 1
        handle_id = self.next_handle_id
        keys: list[tuple[str, int]] = []
        for hardware_id in hardware_ids:
            generation = self.generations.get(hardware_id, 0) + 1
            self.generations[hardware_id] = generation
            keys.append((hardware_id, generation))
        holder = _Holder(normalized, keys)
        self.holders[handle_id] = holder
        for hardware_id, generation in keys:
            self.hardware_holders[hardware_id] = (handle_id, generation)
        self._notify()

        def release() -> None:
            if self.holders.get(handle_id) is not holder:
                return
            del self.holders[handle_id]
            for hardware_id, generation in keys:
                if self.hardware_holders.get(hardware_id) == (handle_id, generation):
                    del self.hardware_holders[hardware_id]
            self._notify()

        return ExecutionHandle(release)

    def _notify(self) -> None:
        if self.notifier:
            self.notifier(self.current())
