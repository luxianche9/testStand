import importlib
import re
from pathlib import Path
from typing import Any

import pytest

from testforge_backend.compat import UNDEFINED, json_parse, json_stringify
from testforge_backend.contracts.devices import parse_mcp_server
from testforge_backend.contracts.projects import parse_project_file
from testforge_backend.contracts.validation import Schema, ValidationError

FIXTURES = Path(__file__).with_name("contracts-golden.json")


def decode(value: Any) -> Any:
    if isinstance(value, dict) and set(value) == {"$js"}:
        return {
            "undefined": UNDEFINED,
            "NaN": float("nan"),
            "Infinity": float("inf"),
            "-Infinity": -float("inf"),
        }[value["$js"]]
    if isinstance(value, list):
        return [decode(item) for item in value]
    if isinstance(value, dict):
        return {key: decode(item) for key, item in value.items()}
    return value


@pytest.mark.parametrize(
    "fixture", json_parse(FIXTURES.read_text(encoding="utf-8")), ids=lambda value: value["id"]
)
def test_original_zod_golden(fixture: dict[str, Any]) -> None:
    domain, export = fixture["schema"].split(".")
    module = importlib.import_module(f"testforge_backend.contracts.{domain}")
    name = re.sub(r"(?<!^)(?=[A-Z])", "_", export).lower()
    value = decode(fixture["input"])
    try:
        if fixture["schema"] == "devices.mcpServerSchema":
            result = parse_mcp_server(value)
        elif fixture["schema"] == "projects.projectFileSchema":
            result = parse_project_file(value)
        else:
            schema: Schema = getattr(module, name)
            result = schema.parse(value)
        actual = {"ok": True, "data": result, "json": json_stringify(result, 2) + "\n"}
    except ValidationError as error:
        actual = {"ok": False, "issues": error.issues, "message": str(error)}
    assert json_parse(json_stringify(actual)) == fixture["expected"]
