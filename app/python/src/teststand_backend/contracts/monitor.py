"""The project's monitor workspace: panels, each showing some device streams, and their layout.

A panel has a ``type`` that decides how it draws its ``sources`` (streams a device plugin
declares) — see :data:`SOURCE_TYPES`; a panel ignores sources it cannot draw. ``settings`` are the
panel's own (see :data:`PANEL_SETTINGS`); a ``control`` panel's ``settings.controls`` are buttons,
switches and sliders bound to device tools with some arguments fixed. ``layout`` is the docking
layout the desktop app saves (opaque here); a panel missing from it is placed by its
``placement`` hint.
"""

from typing import Any

from teststand_backend.contracts.validation import (
    array,
    discriminated,
    enum,
    literal,
    number,
    obj,
    parse_record,
    record,
    string,
    unknown,
)
from teststand_backend.util import Record

SOURCE_TYPES: dict[str, tuple[str, ...]] = {
    "scope": ("scalar", "block", "bits"),
    "digital": ("bits",),
    "terminal": ("bytes", "frames", "events"),
    "trace": ("bytes", "frames"),
    "values": ("scalar", "block"),
    "gauge": ("scalar", "block"),
    "timeline": ("bits",),
    "register": ("bits",),
    "xy": ("scalar", "block"),
    "detail": (),
    "control": (),
    "sources": (),
    "inspector": (),
    "results": (),
    "messages": (),
}
PANEL_TYPES = tuple(SOURCE_TYPES)
PANEL_DESCRIPTIONS = {
    "scope": "oscilloscope of sampled streams (analog overlaid, bits as logic lanes)",
    "digital": "bits streams as lamps / relay contacts; a click toggles a line the device drives",
    "terminal": "serial and bus records as text or hex, with a send bar for serial ports",
    "trace": "bus trace table: by time or one row per id (fixed), column filters, changed "
    "bytes highlighted, decoded with an ICD",
    "values": "table of current value, min / max / mean and a sparkline per stream; setpoints "
    "can be set from it",
    "gauge": "one dial, bar or big number per stream",
    "timeline": "state timeline: one row per bit, coloured while set",
    "register": "status word: hex, a grid of bits, named bit fields, changed bits highlighted",
    "xy": "XY plot: the first source on X, the second on Y",
    "detail": "fields and bytes of the frame selected in a trace panel",
    "control": "buttons, switches and sliders bound to device tools",
    "sources": "tree of devices and their streams, to drag onto panels",
    "inspector": "settings of the selected panel",
    "results": "the run's verdicts",
    "messages": "the run's messages decoded with its ICDs",
}
PANEL_SETTINGS = {
    "trace": '{mode: "time" | "fixed", icd?: ICD name}',
    "values": "{limits?: {'<hardwareId>/<streamId>': {lo?, hi?}}}",
    "gauge": '{style: "dial" | "bar" | "number", min?, max?, limits?}',
    "register": "{fields?: [{name, lsb, width}]}",
    "control": "{controls: [control]}",
}
DIRECTIONS = ("right", "below", "left", "above", "within")
WIDGETS = ("button", "toggle", "slider", "presets")

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
control_schema = obj(
    {
        "id": string(1, 64).optional().describe("Control id; generated when absent."),
        "label": string(0, 80)
        .optional()
        .describe("Text on the control; the tool name when absent."),
        "hardwareId": string(1).describe("Device whose tool the control calls."),
        "tool": string(1).describe("Device tool name, with or without the device prefix."),
        "widget": enum(*WIDGETS).describe(
            "button: one call; toggle: param is a boolean, called with the new state; slider: "
            "param is a number, called on release; presets: one button per preset value of param."
        ),
        "param": string(1)
        .optional()
        .describe("The argument the operator sets (toggle, slider, presets)."),
        "fixed": record(unknown()).default({}).describe("Arguments fixed by the control."),
        "presets": array(unknown()).optional().describe("Values of param offered as buttons."),
        "min": number().optional().describe("Slider minimum; the parameter's when absent."),
        "max": number().optional().describe("Slider maximum; the parameter's when absent."),
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
_SETTINGS_TEXT = "; ".join(f"{kind}: {text}" for kind, text in PANEL_SETTINGS.items())
_NEW_PANEL = obj(
    {
        "id": string(1, 64).optional().describe("Panel id; generated when absent."),
        "type": enum(*PANEL_TYPES).describe(
            "; ".join(f"{kind}: {text}" for kind, text in PANEL_DESCRIPTIONS.items())
        ),
        "title": _TITLE,
        "sources": array(stream_ref_schema).optional().describe("Streams the panel shows."),
        "settings": record(unknown()).optional().describe(f"Panel settings. {_SETTINGS_TEXT}."),
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
                .describe("Merged into the panel's settings (each key replaced)."),
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
        "addControl": obj(
            {
                "op": literal("addControl").describe("Add a control to a control panel."),
                "panelId": _PANEL_ID,
                "control": control_schema.describe("The control."),
            },
            strict=True,
        ),
        "removeControl": obj(
            {
                "op": literal("removeControl").describe("Remove a control from a control panel."),
                "panelId": _PANEL_ID,
                "controlId": string(1).describe("Control id, from get_monitor."),
            },
            strict=True,
        ),
    },
)
monitor_update_input_schema = obj(
    {
        "panels": array(panel_schema).optional(),
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


def parse_control(value: Any) -> Record:
    return parse_record(control_schema, value)


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
