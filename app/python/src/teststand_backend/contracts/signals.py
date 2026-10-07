"""The project's signal view: hardware and widgets on a canvas, joined by logical signal links.

A signal is a stream a device plugin declares, or a signal a passive part (a unit under test)
declares. Links join a device stream to a passive part's signal, a signal to a display widget,
or a control widget to a writable signal. Nothing here refers to pins: the physical wiring is a
separate list.
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

WIDGETS = ("scope", "value", "lamps", "terminal", "switch", "setpoint")

_layout = {
    "nodeId": string(1),
    "x": number(finite=True),
    "y": number(finite=True),
    "width": number(positive=True, finite=True).optional(),
    "height": number(positive=True, finite=True).optional(),
}
signal_node_schema = discriminated(
    "kind",
    {
        "hardware": obj({**_layout, "kind": literal("hardware"), "hardwareId": string(1)}),
        "widget": obj(
            {
                **_layout,
                "kind": literal("widget"),
                "widget": enum(*WIDGETS),
                "label": string().default(""),
                "config": record(unknown()).default({}),
            }
        ),
    },
)
signal_end_schema = obj(
    {
        "nodeId": string(1),
        # A hardware node: the stream or signal id. A widget: "in" (display) or "out" (control).
        "handle": string(1),
        # One line of a bits stream.
        "bit": number(0, 63, integer=True).optional(),
    }
)
signal_link_schema = obj({"linkId": string(1), "from": signal_end_schema, "to": signal_end_schema})
signal_view_schema = obj(
    {
        "nodes": array(signal_node_schema).default([]),
        "links": array(signal_link_schema).default([]),
    }
)
signal_write_input_schema = obj(
    {
        "nodeId": string(1),
        "handle": string(1),
        "bit": number(0, 63, integer=True).optional(),
        "action": enum("set", "setBit", "setMask", "sendText", "sendHex", "sendFrame"),
        "value": unknown(),
    },
    strict=True,
)


def parse_signal_view(value: Any) -> Record:
    return parse_record(signal_view_schema, value)


def parse_signal_write_input(value: Any) -> Record:
    return parse_record(signal_write_input_schema, value)
