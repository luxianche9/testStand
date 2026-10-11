"""The project's monitor panel: which device streams the scope and the terminal show.

A channel names one stream a device plugin declares. Sampled streams (scalar, bits, block) are
drawn on the scope, record streams (bytes, frames, events) are listed in the terminal. The panel
only watches; devices are controlled from their action dialogs and by test steps, and nothing
here refers to pins.
"""

from typing import Any

from teststand_backend.contracts.validation import array, obj, parse_record, string
from teststand_backend.util import Record

stream_ref_schema = obj({"hardwareId": string(1), "streamId": string(1)}, strict=True)
monitor_schema = obj({"channels": array(stream_ref_schema).default([])})
monitor_update_input_schema = obj(
    {
        "channels": array(stream_ref_schema).optional(),
        "add": array(stream_ref_schema).optional(),
        "remove": array(stream_ref_schema).optional(),
    },
    strict=True,
)


def parse_monitor(value: Any) -> Record:
    return parse_record(monitor_schema, value)


def parse_monitor_update_input(value: Any) -> Record:
    return parse_record(monitor_update_input_schema, value)
