"""The project's monitor canvas: one page of panels, each showing some device streams.

A panel has a ``type`` that decides how it draws its ``sources`` (streams a device plugin
declares or protocol fields) — see :data:`SOURCE_TYPES`; a panel ignores sources it cannot draw.
``settings`` are the panel's own (see :data:`PANEL_SETTINGS`); a ``control`` panel's
``settings.controls`` are buttons, switches and sliders bound to device tools with some arguments
fixed, and the one-control widgets (``button``, ``switch``, ``slider``) hold one in
``settings.control`` and show their first source as the value read back. ``frame`` is where the
panel sits on the canvas, in grid cells (:data:`GRID_PX` pixels); a panel without one is placed
in the first free spot.
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
    "number": ("scalar", "block"),
    "lamp": ("bits", "scalar"),
    "switch": ("bits", "scalar"),
    "slider": ("scalar", "block"),
    "button": (),
    "label": (),
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
    "number": "one value in large digits with its unit",
    "lamp": "one indicator lamp: a bit of a bits stream, or a value that is not 0",
    "switch": "an on/off switch that calls a device tool and shows the state read back",
    "slider": "a slider / input that calls a device tool and shows the value read back",
    "button": "a button that calls a device tool once",
    "label": "static text: a heading or a note on the canvas",
}
PANEL_SETTINGS = {
    "trace": '{mode: "time" | "fixed", icd?: ICD name}',
    "values": "{limits?: {'<hardwareId>/<streamId>': {lo?, hi?}}}",
    "gauge": '{style: "dial" | "bar" | "number", min?, max?, limits?}',
    "register": "{fields?: [{name, lsb, width}]}",
    "control": "{controls: [control]}",
    "number": "{decimals?: 0..6}",
    "lamp": '{bit?: n (of a bits stream), onText?, offText?, color?: "pass"|"fail"|"run"|"signal"}',
    "switch": "{control: control (widget toggle), bit?: n}",
    "slider": "{control: control (widget slider)}",
    "button": "{control: control (widget button)}",
    "label": '{text, size?: "sm"|"md"|"lg"}',
}
WIDGETS = ("button", "toggle", "slider", "presets")
GRID_PX = 20
"""Size of a canvas grid cell in pixels."""
CANVAS_COLUMNS = 60
"""Columns new panels are placed within (the canvas itself grows as needed)."""
PANEL_SIZES: dict[str, tuple[int, int]] = {
    "scope": (30, 14), "digital": (20, 7), "terminal": (24, 12), "trace": (30, 14),
    "values": (20, 10), "gauge": (10, 9), "timeline": (24, 9), "register": (14, 9),
    "xy": (14, 14), "detail": (14, 12), "control": (16, 9), "sources": (12, 18),
    "inspector": (12, 18), "results": (20, 10), "messages": (24, 12), "number": (8, 4),
    "lamp": (5, 4), "switch": (8, 4), "slider": (12, 4), "button": (6, 3), "label": (12, 2),
}  # fmt: skip
"""Width and height (cells) a new panel of each type gets."""

stream_ref_schema = obj(
    {
        "hardwareId": string(1).describe("Device hardwareId, from monitor_streams."),
        "streamId": string(1).describe("Stream id the device declares, from monitor_streams."),
    },
    strict=True,
)
frame_schema = obj(
    {
        "x": number(0, 10_000, integer=True).describe("Left edge, grid cells from the left."),
        "y": number(0, 10_000, integer=True).describe("Top edge, grid cells from the top."),
        "w": number(1, 400, integer=True).describe("Width in grid cells."),
        "h": number(1, 400, integer=True).describe("Height in grid cells."),
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
        "frame": frame_schema.optional(),
    },
)
monitor_schema = obj({"panels": array(panel_schema).default([])})

_PANEL_ID = string(1).describe("Panel id, from get_monitor.")
_SOURCES = array(stream_ref_schema, 1).describe("Streams (hardwareId + streamId).")
_TITLE = string(0, 80).optional().describe("Title over the panel.")
_FRAME = frame_schema.optional().describe(
    f"Where it sits on the canvas, in {GRID_PX}px grid cells; first free spot when absent."
)
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
        "frame": _FRAME,
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
            },
            strict=True,
        ),
        "removePanel": obj(
            {"op": literal("removePanel").describe("Remove a panel."), "panelId": _PANEL_ID},
            strict=True,
        ),
        "updatePanel": obj(
            {
                "op": literal("updatePanel").describe(
                    "Retitle a panel, change its settings or move / resize it."
                ),
                "panelId": _PANEL_ID,
                "title": _TITLE,
                "frame": frame_schema.optional().describe("New place and size, in grid cells."),
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
    },
    strict=True,
)


def parse_monitor(value: Any) -> Record:
    return parse_record(monitor_schema, value)


def parse_monitor_update_input(value: Any) -> Record:
    return parse_record(monitor_update_input_schema, value)


def parse_control(value: Any) -> Record:
    return parse_record(control_schema, value)


def free_frame(panels: list[Record], kind: str) -> Record:
    """The first spot (top to bottom, left to right) where a new ``kind`` panel overlaps none."""
    w, h = PANEL_SIZES.get(kind, (12, 8))
    taken = [panel["frame"] for panel in panels if panel.get("frame")]

    def free(x: int, y: int) -> bool:
        return all(
            x + w <= f["x"] or f["x"] + f["w"] <= x or y + h <= f["y"] or f["y"] + f["h"] <= y
            for f in taken
        )

    y = 0
    while True:
        for x in range(0, max(1, CANVAS_COLUMNS - w + 1)):
            if free(x, y):
                return {"x": x, "y": y, "w": w, "h": h}
        y += 1


def placed(panels: list[Record]) -> list[Record]:
    """``panels`` with a frame each: one without (an older project) gets the first free spot."""
    output: list[Record] = []
    for panel in panels:
        output.append(
            panel if panel.get("frame") else {**panel, "frame": free_frame(output, panel["type"])}
        )
    return output


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
