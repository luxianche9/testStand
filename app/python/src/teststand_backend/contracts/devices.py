from typing import Any

from teststand_backend.contracts.validation import (
    Schema,
    array,
    boolean,
    custom_issue,
    enum,
    literal,
    number,
    obj,
    parse_id_input,
    parse_record,
    record,
    string,
    unknown,
)
from teststand_backend.util import Record

connection_state_schema = enum("unknown", "checking", "online", "offline", "error")
# A device plugin loaded into the backend: ``type`` names its ``teststand.devices`` entry point.
# Devices always drive real hardware. Unknown fields are dropped rather than rejected, so a
# record written by an older version (with ``mode``) still loads.
device_instance_schema = obj(
    {
        "deviceId": string(1),
        "label": string(1),
        "hardwareId": string(1),
        "type": string(1),
        "settings": record(unknown()).default({}),
        "enabled": boolean().default(True),
    },
)
hardware_state_schema = enum("initializing", "open", "unreachable", "faulted", "closing", "closed")
_managed_fields = {
    "hardwareId": string(1),
    "deviceId": string(1),
    "state": hardware_state_schema,
    "health": string(),
    "lastError": obj(
        {
            "category": string(1),
            "message": string(),
            "at": string(datetime=True, offset=True).optional(),
        }
    )
    .nullable()
    .optional(),
}
managed_hardware_schema = obj(_managed_fields)
reported_managed_hardware_schema = obj(
    {key: schema for key, schema in _managed_fields.items() if key != "deviceId"}
)
hardware_pin_schema = obj(
    {"pinId": string(1), "position": number(1, integer=True), "label": string().default("")}
)
hardware_port_schema = obj(
    {
        "portId": string(1),
        "name": string(1),
        "pins": array(hardware_pin_schema).default([]),
    }
)
stored_hardware_definition_schema = obj(
    {
        "formatVersion": literal(2).default(2),
        "hardwareId": string(1),
        "label": string(1),
        "ports": array(hardware_port_schema).default([]),
    }
)


def _hardware_issues(value: Any) -> list[Record]:
    issues: list[Record] = []
    if value["kind"] == "managed" and not value.get("deviceId"):
        issues.append(custom_issue("Managed hardware requires deviceId"))
    if value["kind"] == "passive" and value.get("deviceId"):
        issues.append(custom_issue("Passive hardware cannot reference a device instance"))
    ports: set[str] = set()
    for port in value["ports"]:
        if port["portId"] in ports:
            issues.append(custom_issue(f"Duplicate portId: {port['portId']}"))
        ports.add(port["portId"])
        pins: set[str] = set()
        for pin in port["pins"]:
            if pin["pinId"] in pins:
                issues.append(
                    custom_issue(f"Duplicate pinId {pin['pinId']} in port {port['portId']}")
                )
            pins.add(pin["pinId"])
    return issues


hardware_schema = obj(
    {
        "formatVersion": literal(2).default(2),
        "hardwareId": string(1),
        "label": string(1),
        "kind": enum("managed", "passive"),
        "deviceId": string(1).optional(),
        "ports": array(hardware_port_schema).default([]),
    }
).refine(_hardware_issues)
device_bundle_kind_schema = literal("hardware")
device_bundle_apply_input_schema = obj(
    {
        "kind": device_bundle_kind_schema,
        "hardwareId": string(1),
        "deviceId": string(1),
        "data": Schema("bytes"),
    },
    strict=True,
)


def parse_device_instance(value: Any) -> Record:
    return parse_record(device_instance_schema, value)


def parse_hardware(value: Any) -> Record:
    return parse_record(hardware_schema, value)


def parse_stored_hardware_definition(value: Any) -> Record:
    return parse_record(stored_hardware_definition_schema, value)


def parse_managed_hardware(value: Any) -> Record:
    return parse_record(managed_hardware_schema, value)


def parse_reported_managed_hardware(value: Any) -> Record:
    return parse_record(reported_managed_hardware_schema, value)


def parse_device_bundle_apply_input(value: Any) -> Record:
    return parse_record(device_bundle_apply_input_schema, value)


parse_device_id_input = parse_id_input
parse_hardware_id_input = parse_id_input
parse_device_bundle_id_input = parse_id_input
