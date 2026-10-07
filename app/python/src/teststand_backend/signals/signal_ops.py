"""Edits of the signal view as a list of operations, the way the Agent changes the canvas.

Each operation is applied in order to a copy of the view; the result is validated as a whole by the
signal view rules (``signal_view.validate``), so a batch is applied completely or not at all. Ids an
operation creates (``nodeId``, ``linkId``) may be chosen by the caller so that later operations of
the same batch can refer to them.

``default_panel`` lays out every known device with one default widget per stream, the same as the
canvas's "default panel" button: devices in a column, their widgets to the right, analog inputs of
one device sharing one scope. Nodes already on the canvas keep their place; a stream already linked
gets no second widget.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from typing import Any

from teststand_backend.contracts.errors import app_error
from teststand_backend.util import Record, clone

from .signal_view import CONTROL_TYPES, SignalCatalog

WIDGET_SIZES = {
    "scope": (420, 240),
    "value": (180, 96),
    "lamps": (240, 120),
    "terminal": (420, 260),
    "switch": (220, 120),
    "setpoint": (220, 110),
}
_LAYOUT = ("x", "y", "width", "height")


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _issue(message: str) -> Exception:
    return app_error("invalid_argument", message)


def _below(nodes: Iterable[Record]) -> float:
    """The top of a free row under every node on the canvas."""
    return max([40.0, *(node["y"] + node.get("height", 200) + 40 for node in nodes)])


def _node(view: Record, node_id: str) -> Record:
    node = next((item for item in view["nodes"] if item["nodeId"] == node_id), None)
    if node is None:
        raise _issue(f"No node {node_id} on the signal view")
    return node


def _fresh(view: Record, key: str, wanted: str | None, prefix: str) -> str:
    items = view["nodes"] if key == "nodeId" else view["links"]
    if wanted is None:
        return new_id(prefix)
    if any(item[key] == wanted for item in items):
        raise _issue(f"{key} {wanted} is already on the signal view")
    return wanted


def _end(value: Record) -> Record:
    end = {"nodeId": value["nodeId"], "handle": value["handle"]}
    if value.get("bit") is not None:
        end["bit"] = value["bit"]
    return end


def apply_operations(view: Record, operations: list[Record], catalog: SignalCatalog) -> Record:
    """``view`` with ``operations`` applied; the caller validates and saves the result."""
    result = clone(view)
    for index, operation in enumerate(operations):
        kind = operation.get("type")
        try:
            _APPLY[kind](result, operation, catalog)
        except KeyError as error:
            if kind not in _APPLY:
                raise _issue(f"operations[{index}]: unknown type {kind}") from error
            raise _issue(f"operations[{index}] ({kind}): missing {error}") from error
    return result


def _add_hardware(view: Record, operation: Record, catalog: SignalCatalog) -> None:
    hardware_id = operation["hardwareId"]
    if catalog.find_hardware(hardware_id) is None:
        raise _issue(f"Unknown hardware {hardware_id}")
    if any(item.get("hardwareId") == hardware_id for item in view["nodes"]):
        raise _issue(f"{hardware_id} is already on the signal view")
    view["nodes"].append(
        {
            "nodeId": _fresh(view, "nodeId", operation.get("nodeId"), "hw"),
            "kind": "hardware",
            "hardwareId": hardware_id,
            "x": operation.get("x", 40),
            "y": operation.get("y", _below(view["nodes"])),
        }
    )


def _add_widget(view: Record, operation: Record, catalog: SignalCatalog) -> None:
    widget = operation["widget"]
    if widget not in WIDGET_SIZES:
        raise _issue(f"Unknown widget {widget}")
    width, height = WIDGET_SIZES[widget]
    view["nodes"].append(
        {
            "nodeId": _fresh(view, "nodeId", operation.get("nodeId"), "w"),
            "kind": "widget",
            "widget": widget,
            "label": operation.get("label", ""),
            "config": operation.get("config", {}),
            "x": operation.get("x", 360),
            "y": operation.get("y", _below(view["nodes"])),
            "width": operation.get("width", width),
            "height": operation.get("height", height),
        }
    )


def _link(view: Record, operation: Record, catalog: SignalCatalog) -> None:
    source, target = _end(operation["from"]), _end(operation["to"])
    for end in (source, target):
        _node(view, end["nodeId"])
    if any(link["from"] == source and link["to"] == target for link in view["links"]):
        raise _issue("This link is already on the signal view")
    view["links"].append(
        {
            "linkId": _fresh(view, "linkId", operation.get("linkId"), "ln"),
            "from": source,
            "to": target,
        }
    )


def _remove_node(view: Record, operation: Record, catalog: SignalCatalog) -> None:
    node_id = operation["nodeId"]
    _node(view, node_id)
    view["nodes"] = [item for item in view["nodes"] if item["nodeId"] != node_id]
    view["links"] = [
        link
        for link in view["links"]
        if node_id not in (link["from"]["nodeId"], link["to"]["nodeId"])
    ]


def _remove_link(view: Record, operation: Record, catalog: SignalCatalog) -> None:
    link_id = operation["linkId"]
    if not any(link["linkId"] == link_id for link in view["links"]):
        raise _issue(f"No link {link_id} on the signal view")
    view["links"] = [link for link in view["links"] if link["linkId"] != link_id]


def _update_widget(view: Record, operation: Record, catalog: SignalCatalog) -> None:
    node = _node(view, operation["nodeId"])
    if node["kind"] != "widget":
        raise _issue(f"{node['nodeId']} is not a widget")
    if "label" in operation:
        node["label"] = operation["label"]
    if "config" in operation:
        node["config"] = {**node.get("config", {}), **operation["config"]}


def _move_node(view: Record, operation: Record, catalog: SignalCatalog) -> None:
    node = _node(view, operation["nodeId"])
    for key in _LAYOUT:
        if key in operation:
            node[key] = operation[key]


def _clear(view: Record, operation: Record, catalog: SignalCatalog) -> None:
    view["nodes"], view["links"] = [], []


def _default_panel(view: Record, operation: Record, catalog: SignalCatalog) -> None:
    view.update(default_panel(view, catalog_entries(catalog, operation.get("hardwareIds"))))


def catalog_entries(catalog: Any, hardware_ids: list[str] | None) -> list[Record]:
    """``{hardwareId, streams}`` of the known devices; of ``hardware_ids`` only when given."""
    result: list[Record] = []
    wanted = hardware_ids
    if wanted is None:
        wanted = [item["hardwareId"] for item in catalog.list_hardware()]
    for hardware_id in wanted:
        hardware = catalog.find_hardware(hardware_id)
        if hardware is None:
            raise _issue(f"Unknown hardware {hardware_id}")
        if hardware["kind"] == "passive":
            continue
        streams = catalog.known_streams(hardware_id)
        if streams:
            result.append({"hardwareId": hardware_id, "streams": streams})
    return result


def default_widget(stream: Record) -> str | None:
    """The widget the default panel gives a device stream."""
    actions = {str(item.get("action")) for item in stream.get("control") or []}
    kind = stream.get("type")
    if kind == "scalar":
        return "setpoint" if "set" in actions else "scope"
    if kind == "bits":
        return "switch" if "setBit" in actions else "lamps"
    if kind in {"bytes", "frames"}:
        return "terminal"
    return None


def default_panel(view: Record, entries: list[Record]) -> Record:
    """``view`` plus one row per device of ``entries`` (``{hardwareId, streams}``)."""
    nodes = list(view["nodes"])
    links = list(view["links"])
    linked = {
        (end["nodeId"], end["handle"]) for link in links for end in (link["from"], link["to"])
    }
    y = _below(nodes)
    for entry in entries:
        node = next(
            (
                item
                for item in nodes
                if item["kind"] == "hardware" and item["hardwareId"] == entry["hardwareId"]
            ),
            None,
        )
        row_top = node["y"] if node else y
        if node is None:
            node = {
                "nodeId": new_id("hw"),
                "kind": "hardware",
                "hardwareId": entry["hardwareId"],
                "x": 40,
                "y": row_top,
            }
            nodes.append(node)
        x = node["x"] + 320
        scope: str | None = None
        tallest = 0
        for stream in entry["streams"]:
            if (node["nodeId"], stream["id"]) in linked:
                continue
            widget = default_widget(stream)
            if widget is None:
                continue
            signal = {"nodeId": node["nodeId"], "handle": stream["id"]}
            if widget == "scope" and scope:
                links.append(
                    {"linkId": new_id("ln"), "from": signal, "to": {"nodeId": scope, "handle": "in"}}
                )
                continue
            width, height = WIDGET_SIZES[widget]
            node_id = new_id("w")
            nodes.append(
                {
                    "nodeId": node_id,
                    "kind": "widget",
                    "widget": widget,
                    "label": "",
                    "config": {},
                    "x": x,
                    "y": row_top,
                    "width": width,
                    "height": height,
                }
            )
            if widget == "scope":
                scope = node_id
            links.append(
                {
                    "linkId": new_id("ln"),
                    "from": {"nodeId": node_id, "handle": "out"},
                    "to": signal,
                }
                if widget in CONTROL_TYPES
                else {
                    "linkId": new_id("ln"),
                    "from": signal,
                    "to": {"nodeId": node_id, "handle": "in"},
                }
            )
            x += width + 40
            tallest = max(tallest, height)
        y = max(y, row_top + max(tallest, 200) + 60)
    return {"nodes": nodes, "links": links}


_APPLY = {
    "add_hardware": _add_hardware,
    "add_widget": _add_widget,
    "link": _link,
    "remove_node": _remove_node,
    "remove_link": _remove_link,
    "update_widget": _update_widget,
    "move_node": _move_node,
    "default_panel": _default_panel,
    "clear": _clear,
}
OPERATION_TYPES = tuple(_APPLY)
