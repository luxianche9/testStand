from typing import Any

from teststand_backend.contracts.signals import signal_view_schema
from teststand_backend.contracts.validation import (
    literal,
    obj,
    parse_id_input,
    parse_record,
    string,
)
from teststand_backend.contracts.wiring import project_wiring_schema
from teststand_backend.util import Record

PROJECT_FORMAT_VERSION = 5

project_file_schema = obj(
    {
        "formatVersion": literal(PROJECT_FORMAT_VERSION),
        "projectId": string(1),
        "name": string(1),
        "wiring": project_wiring_schema,
        "signals": signal_view_schema,
        "createdAt": string(datetime=True),
        "updatedAt": string(datetime=True),
    }
)


def parse_project_file(value: Any) -> Record:
    return parse_record(project_file_schema, value)


parse_project_root_path_input = parse_id_input
