"""The project's monitor workspace: panels, each showing some device streams, and their layout.

A panel has a ``type`` that decides how it draws its ``sources`` (streams a device plugin
declares): ``scope`` draws sampled streams (scalar, block, bits), ``digital`` bits streams as
lamps and relay contacts, ``terminal`` record streams (bytes, frames); ``results`` and
``messages`` show the run on the panel and take no sources. A panel ignores sources it cannot
draw. ``layout`` is the docking layout the desktop app saves (opaque here); a panel missing from
it is placed by its ``placement`` hint. Devices are controlled by their tools, never from here.

Format 7 projects kept one list of ``channels``; ``migrate_v7`` turns it into a scope panel and a
terminal panel holding every channel (each draws the ones it can).
"""

from typing import Any

from teststand_backend.contracts.validation import (
    array,
    discriminated,
    enum,
    literal,
    obj,
    parse_record,
    record,
    string,
    unknown,
)
from teststand_backend.util import Record

PANEL_TYPES = ("scope", "digital", "terminal", "results", "messages")
SOURCE_TYPES: dict[str, tuple[str, ...]] = {
    "scope": ("scalar", "block", "bits"),
    "digital": ("bits",),
    "terminal": ("bytes", "frames", "events"),
    "results": (),
    "messages": (),
}
DIRECTIONS = ("right", "below", "left", "above", "within")

stream_ref_schema = obj(
    {
        "hardwareId": string(1).describe("Device hardwareId, from monitor_streams."),
        "streamId": string(1).describe("Stream id the device declares, from monitor_streams."),
    },
    strict=True,
)
placement_schema = obj(
    {
        "referenceId": string(1)
        .optional()
        .describe("Panel to place it next to; the last one when absent."),
        "direction": enum(*DIRECTIONS).describe(
            "Side of the reference panel; within = a tab in its group."
        ),
    },
    strict=True,
)
panel_schema = obj(
    {
        "id": string(1, 64),
        "type": enum(*PANEL_TYPES),
        "title": string(0, 80).optional(),
        "sources": array(stream_ref_schema).default([]),
        "settings": record(unknown()).default({}),
        "placement": placement_schema.optional(),
    },
)
monitor_schema = obj(
    {
        "panels": array(panel_schema).default([]),
        "layout": record(unknown()).nullable().default(None),
    },
)

_PANEL_ID = string(1).describe("Panel id, from get_monitor.")
_SOURCES = array(stream_ref_schema, 1).describe("Streams (hardwareId + streamId).")
_TITLE = string(0, 80).optional().describe("Title on the panel's tab.")
_NEW_PANEL = obj(
    {
        "id": string(1, 64).optional().describe("Panel id; generated when absent."),
        "type": enum(*PANEL_TYPES).describe(
            "scope: sampled streams on an oscilloscope; digital: bits as lamps / relay "
            "contacts; terminal: serial and bus records; results / messages: the run's "
            "verdicts / decoded messages."
        ),
        "title": _TITLE,
        "sources": array(stream_ref_schema).optional().describe("Streams the panel shows."),
        "settings": record(unknown()).optional().describe("Panel-specific display settings."),
    },
    strict=True,
)
operation_schema = discriminated(
    "op",
    {
        "addPanel": obj(
            {
                "op": literal("addPanel").describe("Add a panel."),
                "panel": _NEW_PANEL.describe("The new panel."),
                "placement": placement_schema.optional().describe(
                    "Where it docks; right of the last panel when absent."
                ),
            },
            strict=True,
        ),
        "removePanel": obj(
            {"op": literal("removePanel").describe("Remove a panel."), "panelId": _PANEL_ID},
            strict=True,
        ),
        "updatePanel": obj(
            {
                "op": literal("updatePanel").describe("Retitle a panel or change its settings."),
                "panelId": _PANEL_ID,
                "title": _TITLE,
                "settings": record(unknown())
                .optional()
                .describe("Merged into the panel's settings."),
            },
            strict=True,
        ),
        "addSources": obj(
            {
                "op": literal("addSources").describe("Show more streams on a panel."),
                "panelId": _PANEL_ID,
                "sources": _SOURCES,
            },
            strict=True,
        ),
        "removeSources": obj(
            {
                "op": literal("removeSources").describe("Stop showing streams on a panel."),
                "panelId": _PANEL_ID,
                "sources": _SOURCES,
            },
            strict=True,
        ),
    },
)
monitor_update_input_schema = obj(
    {
        "operations": array(operation_schema).optional(),
        "add": array(stream_ref_schema).optional(),
        "remove": array(stream_ref_schema).optional(),
        "layout": record(unknown()).nullable().optional(),
    },
    strict=True,
)


def parse_monitor(value: Any) -> Record:
    return parse_record(monitor_schema, value)


def parse_monitor_update_input(value: Any) -> Record:
    return parse_record(monitor_update_input_schema, value)


def monitor_channels(monitor: Record) -> list[Record]:
    """Every stream some panel shows, once, in panel order."""
    seen: set[tuple[str, str]] = set()
    channels: list[Record] = []
    for panel in monitor.get("panels", []):
        for source in panel.get("sources", []):
            key = (source["hardwareId"], source["streamId"])
            if key not in seen:
                seen.add(key)
                channels.append({"hardwareId": key[0], "streamId": key[1]})
    return channels


def migrate_v7(monitor: Any) -> Record:
    """Format 7 ``{channels}`` -> a scope and a terminal panel holding every channel."""
    channels = list(monitor.get("channels", [])) if isinstance(monitor, dict) else []
    panels: list[Record] = []
    if channels:
        panels = [
            {
                "id": "scope",
                "type": "scope",
                "title": "示波器",
                "sources": channels,
                "settings": {},
            },
            {
                "id": "terminal",
                "type": "terminal",
                "title": "终端",
                "sources": channels,
                "settings": {},
                "placement": {"referenceId": "scope", "direction": "below"},
            },
        ]
    return {"panels": panels, "layout": None}
