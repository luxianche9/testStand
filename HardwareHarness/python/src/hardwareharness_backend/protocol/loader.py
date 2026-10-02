"""Loading ICD documents from text (application-facing helper, design §6.2).

ICD files live in the project as ``icd/<name>.icd.yaml``. Reading the file is the caller's job;
this module only parses text, so it stays free of I/O.
"""

from __future__ import annotations

import io
from typing import Any

from pydantic import ValidationError
from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError
from ruamel.yaml.tokens import TagToken

from hardwareharness_backend.contracts.errors import app_error

from .icd import Icd

ICD_SUFFIX = ".icd.yaml"


def _yaml() -> YAML:
    yaml = YAML(typ="safe", pure=True)
    yaml.allow_duplicate_keys = False
    return yaml


def parse_icd(document: Any) -> Icd:
    """Validate a plain ICD document (already parsed from YAML/JSON)."""
    if not isinstance(document, dict):
        raise app_error("validation_failed", "An ICD document must be an object")
    try:
        return Icd.model_validate(document)
    except ValidationError as error:
        issues = [
            {
                "path": ".".join(str(part) for part in item["loc"]),
                "message": item["msg"],
            }
            for item in error.errors(include_url=False, include_input=False)
        ]
        summary = "; ".join(f"{issue['path'] or '<root>'}: {issue['message']}" for issue in issues)
        raise app_error(
            "validation_failed", f"Invalid ICD: {summary}", {"issues": issues}
        ) from None


def load_icd(text: str) -> Icd:
    """Parse and validate ICD YAML text; custom YAML tags are rejected."""
    yaml = _yaml()
    try:
        if any(isinstance(token, TagToken) for token in yaml.scan(text)):
            raise app_error("invalid_argument", "Custom YAML tags are not allowed in ICD files")
        document = yaml.load(io.StringIO(text))
    except YAMLError as error:
        raise app_error("invalid_argument", f"Invalid ICD YAML: {error}") from None
    return parse_icd(document)


def icd_name_from_path(file_name: str) -> str | None:
    """``dut_cmd.icd.yaml`` -> ``dut_cmd``; ``None`` for other files."""
    return file_name[: -len(ICD_SUFFIX)] if file_name.endswith(ICD_SUFFIX) else None
