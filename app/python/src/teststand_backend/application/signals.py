"""Signal view operations: the signals each hardware offers, the canvas, and writing a signal.

A write goes to the device stream the signal resolves to, as the tool its ``control`` names, through
the same path as a manual tool call (availability check, one execution at a time: nothing is written
while a test runs).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from teststand_backend.contracts.errors import app_error
from teststand_backend.contracts.operations import operation
from teststand_backend.contracts.signals import parse_signal_view, parse_signal_write_input
from teststand_backend.signals.signal_ops import apply_operations
from teststand_backend.signals.signal_view import resolve, validate, write_call

from .authorization import Authorizer, Json

if TYPE_CHECKING:
    from teststand_backend.devices import DeviceCatalogService, DeviceService
    from teststand_backend.projects.project_service import ProjectService
    from teststand_backend.wiring.project_wiring_service import ProjectWiringService

    from .control import ManualControlApplication

WRITE_TIMEOUT_MS = 30_000


class _Catalog:
    """Hardware and its streams as last known (the cached ``/device`` while a device is offline)."""

    def __init__(self, catalog: DeviceCatalogService, devices: DeviceService) -> None:
        self.catalog, self.devices = catalog, devices

    def list_hardware(self) -> list[Json]:
        return self.catalog.list_hardware()

    def find_hardware(self, hardware_id: str) -> Json | None:
        return self.catalog.find_hardware(hardware_id)

    def known_streams(self, hardware_id: str) -> list[Json] | None:
        return self.devices.known_streams(hardware_id)


class SignalsApplication:
    def __init__(
        self,
        authorizer: Authorizer,
        projects: ProjectService,
        wiring: ProjectWiringService,
        catalog: DeviceCatalogService,
        devices: DeviceService,
        manual: ManualControlApplication,
    ) -> None:
        self.authorizer, self.projects, self.wiring, self.manual = (
            authorizer,
            projects,
            wiring,
            manual,
        )
        self.devices = devices
        self.signals = _Catalog(catalog, devices)
        self.catalog = catalog

    @operation(
        "signals.catalog",
        capability="hardware.read",
        risk="read",
        profiles=("plan", "explore"),
        idempotency="natural",
    )
    def catalog_signals(self, context: Json) -> list[Json]:
        """Every hardware with its signals: a device's declared streams (``known`` is false until
        the device was connected once), a passive part's declared signals."""
        result: list[Json] = []
        for hardware in self.catalog.list_hardware():
            entry: Json = {
                "hardwareId": hardware["hardwareId"],
                "label": hardware["label"],
                "kind": hardware["kind"],
            }
            if hardware["kind"] == "passive":
                entry.update(known=True, signals=hardware.get("signals", []))
            else:
                streams = self.signals.known_streams(hardware["hardwareId"])
                entry.update(known=streams is not None, streams=streams or [])
            result.append(entry)
        return result

    @operation(
        "signals.updateDocument",
        capability="projects.manage",
        risk="write",
        idempotency="natural",
    )
    async def update_document(self, context: Json, signals: Json) -> Json:
        view = parse_signal_view(signals)
        validate(view, self.signals)
        document = await self.projects.update_signals_with_layout(view)
        self.wiring.notify_project_changed()
        return document

    @operation(
        "signals.getDocument",
        capability="projects.read",
        risk="read",
        profiles=("plan", "explore"),
        idempotency="natural",
    )
    def get_document(self, context: Json) -> Json:
        """The project's signal view: hardware and widget nodes on the canvas and the links
        between them."""
        return self.projects.signals()

    @operation(
        "signals.applyOperations",
        capability="projects.manage",
        risk="write",
        profiles=("plan", "explore"),
    )
    async def apply_operations(self, context: Json, operations: list[Json]) -> Json:
        """Edit the signal view with a list of operations applied in order; the whole batch is
        checked by the signal view rules and applied completely or not at all. Returns the
        resulting view. Like a canvas edit, it stays in the project buffer until the project is
        saved."""
        view = apply_operations(self.projects.signals(), operations, self.signals)
        document = await self.update_document(context, view)
        signals: Json = document["file"]["signals"]
        return signals

    @operation(
        "signals.write",
        capability="hardware.executeTools",
        risk="actuate",
        profiles=("explore",),
    )
    async def write(self, context: Json, input: Json) -> Json:
        """Write a signal the way a control widget does: ``input`` is ``{nodeId, handle, bit?,
        action, value}`` naming a node and handle on the signal view; action is one of the
        stream's control actions (set, setBit, setMask, sendText, sendHex, sendFrame). Refused
        while a test runs."""
        request = parse_signal_write_input(input)
        end: Json = {key: request[key] for key in ("nodeId", "handle", "bit") if key in request}
        target = resolve(self.projects.signals(), self.signals, end)
        remote, arguments = write_call(
            target, request["action"], request["value"], request.get("bit")
        )
        hardware = self.catalog.get_hardware(target["hardwareId"])
        tool = next(
            (
                item
                for item in self.devices.list_tools()
                if item["deviceId"] == hardware.get("deviceId") and item["remoteName"] == remote
            ),
            None,
        )
        if tool is None:
            raise app_error("unavailable", f"{target['hardwareId']} does not offer {remote} now")
        return await self.manual.invoke_tool(
            context,
            {
                "hardwareId": target["hardwareId"],
                "toolName": tool["externalName"],
                "arguments": arguments,
                "timeoutMs": WRITE_TIMEOUT_MS,
            },
        )
