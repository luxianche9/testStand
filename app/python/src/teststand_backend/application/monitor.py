"""Monitor panel operations: the streams each device offers and the channels the panel shows.

The panel only watches device streams; writing to a device is a tool call (its action dialog,
a test step or the Agent), never a channel.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from teststand_backend.contracts.errors import app_error
from teststand_backend.contracts.monitor import parse_monitor, parse_monitor_update_input
from teststand_backend.contracts.operations import operation

from .authorization import Authorizer, Json

if TYPE_CHECKING:
    from teststand_backend.devices import DeviceCatalogService, DeviceService
    from teststand_backend.projects.project_service import ProjectService
    from teststand_backend.wiring.project_wiring_service import ProjectWiringService


def _key(channel: Json) -> tuple[str, str]:
    return channel["hardwareId"], channel["streamId"]


class MonitorApplication:
    def __init__(
        self,
        authorizer: Authorizer,
        projects: ProjectService,
        wiring: ProjectWiringService,
        catalog: DeviceCatalogService,
        devices: DeviceService,
    ) -> None:
        self.authorizer, self.projects, self.wiring = authorizer, projects, wiring
        self.catalog, self.devices = catalog, devices

    @operation(
        "monitor.streams",
        capability="hardware.read",
        risk="read",
        profiles=("plan", "explore"),
        idempotency="natural",
    )
    def streams(self, context: Json) -> list[Json]:
        """Every device with the streams it declares (``known`` is false until the device was
        connected once; the cached declaration is used while it is offline)."""
        result: list[Json] = []
        for hardware in self.catalog.list_hardware():
            if hardware["kind"] != "managed":
                continue
            streams = self.devices.known_streams(hardware["hardwareId"])
            result.append(
                {
                    "hardwareId": hardware["hardwareId"],
                    "label": hardware["label"],
                    "known": streams is not None,
                    "streams": streams or [],
                }
            )
        return result

    @operation(
        "monitor.get",
        capability="projects.read",
        risk="read",
        profiles=("plan", "explore"),
        idempotency="natural",
    )
    def get(self, context: Json) -> Json:
        """The channels the monitor panel shows, in order."""
        return self.projects.monitor()

    @operation(
        "monitor.update",
        capability="projects.manage",
        risk="write",
        profiles=("plan", "explore"),
        idempotency="natural",
    )
    async def update(self, context: Json, input: Json) -> Json:
        """Change the panel's channels: ``channels`` replaces the list, then ``remove`` and
        ``add`` (appended when not yet shown) apply. A stream must belong to a registered device
        and, once the device's streams are known, be one it declares. Stays in the project buffer
        until the project is saved. Returns the panel."""
        request = parse_monitor_update_input(input)
        given = request.get("channels")
        channels: list[Json] = list(
            given if given is not None else self.projects.monitor()["channels"]
        )
        removed = {_key(item) for item in request.get("remove", [])}
        channels = [item for item in channels if _key(item) not in removed]
        for item in request.get("add", []):
            if _key(item) not in {_key(entry) for entry in channels}:
                channels.append(item)
        seen: set[tuple[str, str]] = set()
        for item in channels:
            key = _key(item)
            if key in seen:
                raise app_error("invalid_argument", f"{key[0]}.{key[1]} is shown twice")
            seen.add(key)
            self._check(item)
        monitor = parse_monitor({"channels": channels})
        self.projects.update_monitor(monitor)
        self.wiring.notify_project_changed()
        return self.projects.monitor()

    def _check(self, channel: Json) -> None:
        hardware = self.catalog.find_hardware(channel["hardwareId"])
        if hardware is None or hardware["kind"] != "managed":
            raise app_error(
                "invalid_argument", f"{channel['hardwareId']} is not a registered device"
            )
        streams = self.devices.known_streams(channel["hardwareId"])
        if streams is not None and channel["streamId"] not in {item["id"] for item in streams}:
            raise app_error(
                "invalid_argument",
                f"{channel['hardwareId']} declares no stream {channel['streamId']}; "
                "read monitor_streams for exact ids",
            )
