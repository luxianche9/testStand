"""Monitor workspace operations: the streams each device offers and the panels that show them.

Panels only watch device streams; writing to a device is a tool call (its action dialog,
a test step or the Agent), never a panel source.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from teststand_backend.contracts.errors import app_error
from teststand_backend.contracts.monitor import (
    SOURCE_TYPES,
    parse_monitor,
    parse_monitor_update_input,
)
from teststand_backend.contracts.operations import operation

from .authorization import Authorizer, Json

if TYPE_CHECKING:
    from teststand_backend.devices import DeviceCatalogService, DeviceService
    from teststand_backend.projects.project_service import ProjectService
    from teststand_backend.wiring.project_wiring_service import ProjectWiringService

DEFAULT_PANEL = (("scope", SOURCE_TYPES["scope"]), ("terminal", SOURCE_TYPES["terminal"]))
"""Where ``add`` puts a stream: the first panel of the first kind that draws its type."""


def _key(channel: Json) -> tuple[str, str]:
    return channel["hardwareId"], channel["streamId"]


def _panel(panels: list[Json], panel_id: str) -> Json:
    for panel in panels:
        if panel["id"] == panel_id:
            return panel
    raise app_error(
        "invalid_argument",
        f"no panel {panel_id}; panels: {', '.join(item['id'] for item in panels) or 'none'}",
    )


def _new_id(panels: list[Json], kind: str) -> str:
    taken = {panel["id"] for panel in panels}
    if kind not in taken:
        return kind
    index = 2
    while f"{kind}{index}" in taken:
        index += 1
    return f"{kind}{index}"


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
        """The monitor workspace: its panels (type, title, sources, settings) and layout."""
        return self.projects.monitor()

    @operation(
        "monitor.update",
        capability="projects.manage",
        risk="write",
        profiles=("plan", "explore"),
        idempotency="natural",
    )
    async def update(self, context: Json, input: Json) -> Json:
        """Change the workspace: ``operations`` apply in order (add / remove / update a panel,
        add / remove its sources); ``remove`` then takes each stream off every panel and ``add``
        puts it on the first panel that draws its type (a new one when none does); ``layout``
        replaces the saved docking layout. A stream must belong to a registered device and,
        once the device's streams are known, be one it declares and one the panel can draw.
        Stays in the project buffer until the project is saved. Returns the workspace."""
        request = parse_monitor_update_input(input)
        monitor = self.projects.monitor()
        panels: list[Json] = monitor["panels"]
        for item in request.get("operations", []):
            self._apply(panels, item)
        removed = {_key(item) for item in request.get("remove", [])}
        for panel in panels:
            panel["sources"] = [item for item in panel["sources"] if _key(item) not in removed]
        for item in request.get("add", []):
            self._add_default(panels, item)
        if "layout" in request:
            monitor["layout"] = request["layout"]
        self.projects.update_monitor(parse_monitor({**monitor, "panels": panels}))
        self.wiring.notify_project_changed()
        return self.projects.monitor()

    def _apply(self, panels: list[Json], change: Json) -> None:
        op = change["op"]
        if op == "addPanel":
            spec = change["panel"]
            panel_id = spec.get("id") or _new_id(panels, spec["type"])
            if any(panel["id"] == panel_id for panel in panels):
                raise app_error("invalid_argument", f"panel {panel_id} already exists")
            panel: Json = {
                "id": panel_id,
                "type": spec["type"],
                "sources": [],
                "settings": dict(spec.get("settings", {})),
            }
            if spec.get("title") is not None:
                panel["title"] = spec["title"]
            placement = change.get("placement")
            if placement is not None:
                if placement.get("referenceId") is not None:
                    _panel(panels, placement["referenceId"])
                panel["placement"] = placement
            self._add_sources(panel, spec.get("sources", []))
            panels.append(panel)
            return
        panel = _panel(panels, change["panelId"])
        if op == "removePanel":
            panels.remove(panel)
        elif op == "updatePanel":
            if "title" in change:
                panel["title"] = change["title"]
            if "settings" in change:
                panel["settings"] = {**panel["settings"], **change["settings"]}
        elif op == "addSources":
            self._add_sources(panel, change["sources"])
        else:
            removed = {_key(item) for item in change["sources"]}
            panel["sources"] = [item for item in panel["sources"] if _key(item) not in removed]

    def _add_sources(self, panel: Json, sources: list[Json]) -> None:
        accepted = SOURCE_TYPES[panel["type"]]
        for item in sources:
            stream_type = self._check(item)
            if stream_type is not None and stream_type not in accepted:
                raise app_error(
                    "invalid_argument",
                    f"{item['hardwareId']}.{item['streamId']} is a {stream_type} stream; a "
                    f"{panel['type']} panel draws {', '.join(accepted) or 'no streams'}",
                )
            if _key(item) not in {_key(entry) for entry in panel["sources"]}:
                panel["sources"].append(
                    {"hardwareId": item["hardwareId"], "streamId": item["streamId"]}
                )

    def _add_default(self, panels: list[Json], item: Json) -> None:
        stream_type = self._check(item)
        if any(_key(item) in {_key(entry) for entry in panel["sources"]} for panel in panels):
            return
        kind = next(
            (kind for kind, types in DEFAULT_PANEL if stream_type is None or stream_type in types),
            "terminal",
        )
        panel = next((panel for panel in panels if panel["type"] == kind), None)
        if panel is None:
            panel = {"id": _new_id(panels, kind), "type": kind, "sources": [], "settings": {}}
            panels.append(panel)
        self._add_sources(panel, [item])

    def _check(self, channel: Json) -> str | None:
        """The stream's type (``None`` while the device's streams are unknown); raises when the
        device is not registered or does not declare the stream."""
        hardware = self.catalog.find_hardware(channel["hardwareId"])
        if hardware is None or hardware["kind"] != "managed":
            raise app_error(
                "invalid_argument", f"{channel['hardwareId']} is not a registered device"
            )
        streams = self.devices.known_streams(channel["hardwareId"])
        if streams is None:
            return None
        for item in streams:
            if item["id"] == channel["streamId"]:
                return str(item["type"])
        raise app_error(
            "invalid_argument",
            f"{channel['hardwareId']} declares no stream {channel['streamId']}; "
            "read monitor_streams for exact ids",
        )
