"""Signal view rules: what may be linked to what, and which device stream a signal ends up at.

The signals of a hardware node are the streams its plugin declares (a device) or the signals it
declares itself (a passive part). Links:

* device stream <-> passive signal: the passive signal is carried by that stream (one per signal);
* signal -> display widget (``in``): scope (scalar, bits), value (scalar), lamps (bits), terminal
  (bytes, frames);
* control widget (``out``) -> writable signal: switch (bits), setpoint (scalar).

A passive signal resolves through its link to a device stream; reads and writes always go to that
stream. Streams of a device that is not known yet (never connected) are not checked here; they
fail when resolved.
"""

from __future__ import annotations

from typing import Any, Protocol

from teststand_backend.contracts.errors import app_error
from teststand_backend.util import Record

DISPLAY_TYPES = {
    "scope": {"scalar", "bits"},
    "value": {"scalar"},
    "lamps": {"bits"},
    "terminal": {"bytes", "frames"},
}
CONTROL_TYPES = {"switch": {"bits"}, "setpoint": {"scalar"}}
MULTI_INPUT = {"scope"}
WRITE_ACTIONS = {
    "scalar": ("set",),
    "bits": ("setBit", "setMask"),
    "bytes": ("sendText", "sendHex"),
    "frames": ("sendFrame",),
}


class SignalCatalog(Protocol):
    def find_hardware(self, hardware_id: str) -> Record | None: ...
    def known_streams(self, hardware_id: str) -> list[Record] | None: ...


class Signal:
    """One end as a typed signal: ``width`` is the number of bit lines of a bits signal."""

    def __init__(
        self,
        kind: str,
        type: str,
        width: int | None,
        controls: list[Record],
        direction: str | None = None,
    ) -> None:
        self.kind, self.type, self.width, self.controls, self.direction = (
            kind,
            type,
            width,
            controls,
            direction,
        )

    def actions(self) -> set[str]:
        return {str(item.get("action")) for item in self.controls}


def _issue(message: str) -> Exception:
    return app_error("invalid_argument", message)


def _nodes(view: Record) -> dict[str, Record]:
    nodes: dict[str, Record] = {}
    for node in view["nodes"]:
        if node["nodeId"] in nodes:
            raise _issue(f"Duplicate nodeId: {node['nodeId']}")
        nodes[node["nodeId"]] = node
    return nodes


def signal_at(catalog: SignalCatalog, node: Record, end: Record) -> Signal | None:
    """The signal at a hardware node's ``end``; ``None`` when the hardware's streams are unknown."""
    hardware = catalog.find_hardware(node["hardwareId"])
    if hardware is None:
        return None
    bit = end.get("bit")
    if hardware["kind"] == "passive":
        declared = next(
            (item for item in hardware.get("signals", []) if item["signalId"] == end["handle"]),
            None,
        )
        if declared is None:
            raise _issue(f"{node['hardwareId']} declares no signal {end['handle']}")
        if bit is not None:
            raise _issue(f"{node['hardwareId']}.{end['handle']}: link a passive signal as a whole")
        width = declared.get("width", 1) if declared["type"] == "bits" else None
        return Signal("passive", declared["type"], width, [], declared["direction"])
    streams = catalog.known_streams(node["hardwareId"])
    if streams is None:
        return None
    stream = next((item for item in streams if item["id"] == end["handle"]), None)
    if stream is None:
        raise _issue(f"{node['hardwareId']} has no stream {end['handle']}")
    controls = list(stream.get("control") or [])
    if stream["type"] == "bits":
        width = int(stream.get("width") or 64)
        if bit is not None:
            if bit >= width:
                raise _issue(f"{node['hardwareId']}.{end['handle']} has no bit {bit}")
            return Signal(
                "device", "bits", 1, [item for item in controls if item.get("action") == "setBit"]
            )
        return Signal("device", "bits", width, controls)
    if bit is not None:
        raise _issue(f"{node['hardwareId']}.{end['handle']}: only bits streams have bits")
    return Signal("device", str(stream["type"]), None, controls)


def _widget_end(node: Record, end: Record) -> str:
    handle = "out" if node["widget"] in CONTROL_TYPES else "in"
    if end["handle"] != handle or "bit" in end:
        raise _issue(f"Widget {node['nodeId']} ({node['widget']}) links through '{handle}'")
    return handle


def validate(view: Record, catalog: SignalCatalog) -> None:
    """Raise ``invalid_argument`` when a link breaks the signal view rules."""
    nodes = _nodes(view)
    link_ids: set[str] = set()
    carried: set[tuple[str, str]] = set()
    inputs: set[str] = set()
    for link in view["links"]:
        if link["linkId"] in link_ids:
            raise _issue(f"Duplicate linkId: {link['linkId']}")
        link_ids.add(link["linkId"])
        source, target = (nodes.get(link[key]["nodeId"]) for key in ("from", "to"))
        if source is None or target is None:
            raise _issue(f"Link {link['linkId']} joins a node that is not on the canvas")
        kinds = (source["kind"], target["kind"])
        if kinds == ("widget", "widget"):
            raise _issue(f"Link {link['linkId']}: widgets link to signals, not to each other")
        if kinds == ("hardware", "hardware"):
            _check_carrier(link, source, target, catalog, carried)
            continue
        widget, hardware, widget_end, hardware_end = (
            (target, source, link["to"], link["from"])
            if target["kind"] == "widget"
            else (source, target, link["from"], link["to"])
        )
        handle = _widget_end(widget, widget_end)
        if (handle == "in") != (target is widget):
            raise _issue(f"Link {link['linkId']}: signals flow into displays and out of controls")
        if widget["widget"] not in MULTI_INPUT:
            if widget["nodeId"] in inputs:
                raise _issue(f"Widget {widget['nodeId']} ({widget['widget']}) shows one signal")
            inputs.add(widget["nodeId"])
        signal = _resolved_signal(view, nodes, catalog, hardware, hardware_end)
        if signal is None:
            continue
        accepted = DISPLAY_TYPES.get(widget["widget"]) or CONTROL_TYPES[widget["widget"]]
        if signal.type not in accepted:
            name = f"{widget['nodeId']} ({widget['widget']})"
            raise _issue(f"Widget {name} does not take {signal.type} signals")
        # A control on a passive signal not yet carried by a stream is checked once it is.
        if handle == "out" and signal.kind == "device" and not _writable(signal):
            raise _issue(f"Link {link['linkId']}: {hardware_end['handle']} cannot be written")


def _check_carrier(
    link: Record,
    source: Record,
    target: Record,
    catalog: SignalCatalog,
    carried: set[tuple[str, str]],
) -> None:
    ends = [(source, link["from"]), (target, link["to"])]
    signals = [signal_at(catalog, node, end) for node, end in ends]
    known = [signal for signal in signals if signal is not None]
    if len(known) == 2 and {signal.kind for signal in known} != {"device", "passive"}:
        raise _issue(f"Link {link['linkId']}: join a device stream to a signal of a passive part")
    passive_index = next(
        (
            index
            for index, signal in enumerate(signals)
            if signal is not None and signal.kind == "passive"
        ),
        None,
    )
    if passive_index is not None:
        node, end = ends[passive_index]
        key = (node["nodeId"], end["handle"])
        if key in carried:
            raise _issue(
                f"{node['hardwareId']}.{end['handle']} is already carried by another stream"
            )
        carried.add(key)
    if len(known) < 2:
        return
    device, passive = sorted(known, key=lambda signal: signal.kind)
    if device.type != passive.type or (device.type == "bits" and device.width != passive.width):
        raise _issue(
            f"Link {link['linkId']}: {_describe(device)} cannot carry {_describe(passive)}"
        )
    if passive.direction == "input" and not _writable(device):
        raise _issue(
            f"Link {link['linkId']}: an input of the part needs a stream the device can write"
        )


def _describe(signal: Signal) -> str:
    return f"{signal.width}-bit bits" if signal.type == "bits" else signal.type


def _writable(signal: Signal) -> bool:
    return bool(signal.actions() & set(WRITE_ACTIONS.get(signal.type, ())))


def _resolved_signal(
    view: Record, nodes: dict[str, Record], catalog: SignalCatalog, node: Record, end: Record
) -> Signal | None:
    signal = signal_at(catalog, node, end)
    if signal is None or signal.kind == "device":
        return signal
    carrier = _carrier(view, nodes, node, end)
    if carrier is None:
        return signal
    resolved = signal_at(catalog, *carrier)
    return resolved or signal


def _carrier(
    view: Record, nodes: dict[str, Record], node: Record, end: Record
) -> tuple[Record, Record] | None:
    """The device node and stream end linked to a passive signal."""
    for link in view["links"]:
        for mine, other in (("from", "to"), ("to", "from")):
            here = link[mine]
            if here["nodeId"] == node["nodeId"] and here["handle"] == end["handle"]:
                peer = nodes.get(link[other]["nodeId"])
                if peer is not None and peer["kind"] == "hardware":
                    return peer, link[other]
    return None


def resolve(view: Record, catalog: SignalCatalog, end: Record) -> Record:
    """``{hardwareId, streamId, bit?, stream}`` of the device stream that carries ``end``."""
    nodes = _nodes(view)
    node = nodes.get(end["nodeId"])
    if node is None or node["kind"] != "hardware":
        raise app_error("not_found", f"No hardware node {end['nodeId']} on the signal view")
    hardware = catalog.find_hardware(node["hardwareId"])
    if hardware is None:
        raise app_error("not_found", f"Unknown hardware {node['hardwareId']}")
    if hardware["kind"] == "passive":
        signal_at(catalog, node, end)
        carrier = _carrier(view, nodes, node, end)
        if carrier is None:
            raise app_error(
                "conflict", f"{node['hardwareId']}.{end['handle']} is not linked to a device stream"
            )
        node, end = carrier
    streams = catalog.known_streams(node["hardwareId"])
    stream = next((item for item in streams or [] if item["id"] == end["handle"]), None)
    if stream is None:
        raise app_error(
            "unavailable", f"Stream {end['handle']} of {node['hardwareId']} is not known yet"
        )
    result: Record = {"hardwareId": node["hardwareId"], "streamId": stream["id"], "stream": stream}
    if "bit" in end:
        result["bit"] = end["bit"]
    return result


def write_call(target: Record, action: str, value: Any, bit: int | None) -> tuple[str, Record]:
    """The tool name and arguments that perform ``action`` on the resolved stream ``target``."""
    stream = target["stream"]
    if bit is None:
        bit = target.get("bit")
    if action not in WRITE_ACTIONS.get(str(stream["type"]), ()):
        raise app_error("invalid_argument", f"{action} does not write {stream['type']} streams")
    control = next(
        (item for item in stream.get("control") or [] if item.get("action") == action), None
    )
    if control is None:
        raise app_error(
            "invalid_argument",
            f"{target['hardwareId']}.{stream['id']} declares no {action} control",
        )
    fills = _fills(action, value, bit)
    arguments: Record = {"hardwareId": target["hardwareId"]}
    for key, template in (control.get("args") or {}).items():
        if isinstance(template, dict) and set(template) == {"$"}:
            name = template["$"]
            if name not in fills:
                raise app_error("invalid_argument", f"{action} needs {name}")
            arguments[key] = fills[name]
        else:
            arguments[key] = template
    return str(control["tool"]), arguments


def _fills(action: str, value: Any, bit: int | None) -> Record:
    if action == "setBit":
        if bit is None or not isinstance(value, bool):
            raise app_error("invalid_argument", "setBit takes one bit and a boolean value")
        return {"bit": bit, "value": value}
    if action == "setMask":
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise app_error("invalid_argument", "setMask takes a non-negative integer")
        return {"value": value}
    if action == "set":
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise app_error("invalid_argument", "set takes a number")
        return {"value": value}
    if action in {"sendText", "sendHex"}:
        if not isinstance(value, str):
            raise app_error("invalid_argument", f"{action} takes a string")
        return {"text": value} if action == "sendText" else {"hex": value}
    frame = value if isinstance(value, dict) else {}
    if not isinstance(frame.get("id"), int) or not isinstance(frame.get("hex"), str):
        raise app_error("invalid_argument", "sendFrame takes {id, hex}")
    return {"id": frame["id"], "hex": frame["hex"]}
