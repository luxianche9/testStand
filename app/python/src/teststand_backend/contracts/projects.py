from typing import Any

from teststand_backend.contracts.monitor import monitor_schema
from teststand_backend.contracts.validation import (
    array,
    enum,
    literal,
    obj,
    parse_id_input,
    parse_record,
    string,
)
from teststand_backend.contracts.wiring import project_wiring_schema
from teststand_backend.util import Record

PROJECT_FORMAT_VERSION = 8

NAME = r"^[A-Za-z_][A-Za-z0-9_]*$"
"""An ICD name or a protocol alias (``protocol.derived.ALIAS``)."""

protocol_binding_schema = obj(
    {
        "icd": string(1, regex=NAME).describe("ICD name: the file icd/<name>.icd.yaml."),
        "alias": string(1, 64, regex=NAME).describe(
            "Prefix of the derived streams <alias>.<message>.<field>; unique in the project."
        ),
        "source": obj(
            {
                "hardwareId": string(1).describe("Managed hardware whose stream is decoded."),
                "streamId": string(1).describe("Its raw bytes or frames stream."),
            },
            strict=True,
        ),
    },
    strict=True,
)
"""One ICD put on a raw stream of a device (design §6.4): monitor, Agent and every test plan
see its fields as streams of the source hardware."""

project_file_schema = obj(
    {
        "formatVersion": literal(PROJECT_FORMAT_VERSION),
        "projectId": string(1),
        "name": string(1),
        "wiring": project_wiring_schema,
        "monitor": monitor_schema,
        "protocols": array(protocol_binding_schema).default([]),
        "createdAt": string(datetime=True),
        "updatedAt": string(datetime=True),
    }
)

protocol_operation_schema = obj(
    {
        "op": enum("add", "update", "remove").describe(
            "add a binding, update the one with this alias (icd / source), or remove it."
        ),
        "alias": string(1, 64, regex=NAME).describe(
            "The binding's alias: prefix of its streams <alias>.<message>.<field>."
        ),
        "icd": string(1, regex=NAME).optional().describe("ICD name (icd/<name>.icd.yaml)."),
        "source": obj(
            {
                "hardwareId": string(1).describe("Managed hardware whose stream is decoded."),
                "streamId": string(1).describe("Its raw bytes or frames stream."),
            },
            strict=True,
        )
        .optional()
        .describe("The raw stream the ICD decodes."),
    },
    strict=True,
)

protocols_update_schema = obj(
    {"operations": array(protocol_operation_schema, 1).describe("Applied in order.")},
    strict=True,
)


def parse_project_file(value: Any) -> Record:
    return parse_record(project_file_schema, value)


def parse_protocol_bindings(value: Any) -> list[Record]:
    parsed: list[Record] = array(protocol_binding_schema).parse(value)
    return parsed


def parse_protocols_update_input(value: Any) -> Record:
    return parse_record(protocols_update_schema, value)


parse_project_root_path_input = parse_id_input
