from typing import Any

from testforge_backend.compat import Record
from testforge_backend.contracts.validation import (
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
    string,
)

connection_state_schema = enum("unknown", "checking", "online", "offline", "error")
remote_computer_schema = obj(
    {
        "id": string(1),
        "label": string(1),
        "address": string(1),
        "execution": enum("ssh", "local").optional(),
        "ssh": obj(
            {
                "port": number(1, 65535, integer=True).default(22),
                "username": string(1),
                "hostKeyFingerprint": string().optional(),
                "shell": enum("powershell", "posix").default("powershell"),
            }
        ),
    }
).refine(
    lambda value: (
        [custom_issue("Local computers require a loopback address", ["address"])]
        if value.get("execution") == "local"
        and value["address"] not in {"127.0.0.1", "localhost", "::1"}
        else []
    )
)
server_lifecycle_schema = obj(
    {
        "statusCommand": string(1),
        "startCommand": string(1),
        "stopCommand": string(1),
        "logPath": string(1),
    },
    strict=True,
)
mcp_http_server_schema = obj(
    {
        "transport": literal("mcp-http"),
        "serverId": string(1),
        "computerId": string(1),
        "label": string(1),
        "hardwareId": string(1),
        "url": string(url=True),
        "enabled": boolean().default(True),
        "lifecycle": server_lifecycle_schema,
    },
    strict=True,
)
hardware_state_schema = enum("initializing", "open", "unreachable", "faulted", "closing", "closed")
_managed_fields = {
    "hardwareId": string(1),
    "computerId": string(1),
    "serverId": string(1),
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
    {
        key: schema
        for key, schema in _managed_fields.items()
        if key not in ("computerId", "serverId")
    }
)
hardware_pin_schema = obj(
    {"pinId": string(1), "position": number(1, integer=True), "label": string().default("")}
)
hardware_port_schema = obj(
    {
        "portId": string(1),
        "name": string(1),
        "pins": array(hardware_pin_schema).default([]),
        "imageAssetId": string(1).optional(),
    }
)
stored_hardware_definition_schema = obj(
    {
        "formatVersion": literal(2).default(2),
        "hardwareId": string(1),
        "label": string(1),
        "ports": array(hardware_port_schema).default([]),
        "appearanceAssetId": string(1).optional(),
    }
)


def _hardware_issues(value: Any) -> list[Record]:
    issues: list[Record] = []
    if value["kind"] == "managed" and (not value.get("serverId") or not value.get("computerId")):
        issues.append(custom_issue("Managed hardware requires serverId and computerId"))
    if value["kind"] == "passive" and (value.get("serverId") or value.get("computerId")):
        issues.append(custom_issue("Passive hardware cannot reference remote infrastructure"))
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
        "serverId": string(1).optional(),
        "computerId": string(1).optional(),
        "ports": array(hardware_port_schema).default([]),
        "appearanceAssetId": string(1).optional(),
    }
).refine(_hardware_issues)
hardware_image_target_schema = obj(
    {"hardwareId": string(1), "portId": string(1).optional()}, strict=True
)
device_bundle_kind_schema = literal("hardware")
device_bundle_apply_input_schema = obj(
    {
        "kind": device_bundle_kind_schema,
        "hardwareId": string(1),
        "serverId": string(1),
        "data": Schema("bytes"),
    },
    strict=True,
)


def parse_remote_computer(value: Any) -> Record:
    return parse_record(remote_computer_schema, value)


def parse_mcp_server(value: Any) -> Record:
    if isinstance(value, dict) and "transport" not in value:
        value = {**value, "transport": "mcp-http"}
    from testforge_backend.contracts.validation import discriminated

    return parse_record(discriminated("transport", {"mcp-http": mcp_http_server_schema}), value)


def parse_hardware(value: Any) -> Record:
    return parse_record(hardware_schema, value)


def parse_stored_hardware_definition(value: Any) -> Record:
    return parse_record(stored_hardware_definition_schema, value)


def parse_managed_hardware(value: Any) -> Record:
    return parse_record(managed_hardware_schema, value)


def parse_reported_managed_hardware(value: Any) -> Record:
    return parse_record(reported_managed_hardware_schema, value)


def parse_hardware_image_target(value: Any) -> Record:
    return parse_record(hardware_image_target_schema, value)


def parse_device_bundle_apply_input(value: Any) -> Record:
    return parse_record(device_bundle_apply_input_schema, value)


parse_computer_id_input = parse_id_input
parse_server_id_input = parse_id_input
parse_hardware_id_input = parse_id_input
parse_asset_id_input = parse_id_input
parse_device_bundle_id_input = parse_id_input
