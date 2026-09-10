from typing import Any

from testforge_backend.compat import Record
from testforge_backend.contracts.orchestration import test_task_schema
from testforge_backend.contracts.validation import (
    discriminated,
    literal,
    obj,
    parse_id_input,
    parse_record,
    string,
)
from testforge_backend.contracts.wiring import project_wiring_schema

_metadata = {
    "projectId": string(1),
    "name": string(1),
    "wiring": project_wiring_schema,
    "createdAt": string(datetime=True),
    "updatedAt": string(datetime=True),
}
project_file_v1_schema = obj(
    {"formatVersion": literal(1), **_metadata, "task": test_task_schema.optional()}
)
project_file_v2_schema = obj({"formatVersion": literal(2), **_metadata, "task": test_task_schema})
project_file_v3_schema = obj({"formatVersion": literal(3), **_metadata, "task": test_task_schema})
project_file_version_schema = discriminated(
    "formatVersion",
    {1: project_file_v1_schema, 2: project_file_v2_schema, 3: project_file_v3_schema},
)


def upgrade_project_file(source: Record) -> Record:
    current = source
    if source["formatVersion"] == 1:
        current = {
            **source,
            "formatVersion": 2,
            "task": source.get("task")
            or {
                "formatVersion": 2,
                "taskId": f"{source['projectId']}-task",
                "name": source["name"],
                "inputs": [],
                "variables": [],
                "setup": [],
                "steps": [],
                "cleanup": [],
            },
        }
    if current["formatVersion"] == 2:
        current = {**current, "formatVersion": 3}
    return parse_record(project_file_v3_schema, current)


def parse_project_file(value: Any) -> Record:
    return upgrade_project_file(parse_record(project_file_version_schema, value))


parse_project_root_path_input = parse_id_input
