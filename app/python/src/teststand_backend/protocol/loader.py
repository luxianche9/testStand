"""Loading ICD documents from text (application-facing helper, design §6.2).

ICD files live in the project as ``icd/<name>.icd.yaml``. Reading the file is the caller's job;
this module only parses text, so it stays free of I/O.
"""

from __future__ import annotations

import io
from typing import Any

from pydantic import ValidationError
from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.error import YAMLError
from ruamel.yaml.scalarstring import DoubleQuotedScalarString
from ruamel.yaml.tokens import TagToken

from teststand_backend.contracts.errors import app_error

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


FLOW_ITEMS = frozenset({"fields", "match"})
"""Lists whose items are written one per line, as flow mappings."""
FLOW_MAPS = frozenset({"lengthField", "range", "template", "enum"})
HEX_KEYS = frozenset({"header", "footer", "delimiter"})


def _node(value: Any, key: str | None = None, flow: bool = False) -> Any:
    if isinstance(value, dict):
        node = CommentedMap()
        for item_key, item in value.items():
            if key == "enum" and isinstance(item_key, str) and item_key.lstrip("-").isdigit():
                item_key = int(item_key)
            node[item_key] = _node(item, str(item_key), flow)
        if flow or key in FLOW_MAPS:
            node.fa.set_flow_style()
        return node
    if isinstance(value, list):
        return CommentedSeq(_node(item, key, flow or key in FLOW_ITEMS) for item in value)
    if key in HEX_KEYS and isinstance(value, str):
        return DoubleQuotedScalarString(value)  # "10" must stay text, not become an integer
    return value


def dump_icd(icd: Icd) -> str:
    """YAML text of ``icd`` as a person would write it: defaults left out, every field and match
    condition on one line. ``load_icd(dump_icd(icd)) == icd``; comments of an edited file are
    lost."""
    yaml = YAML(typ="rt")
    yaml.width = 4096
    yaml.indent(mapping=2, sequence=4, offset=2)
    stream = io.StringIO()
    yaml.dump(_node(icd.model_dump(mode="json", by_alias=True, exclude_defaults=True)), stream)
    return stream.getvalue()


def icd_name_from_path(file_name: str) -> str | None:
    """``dut_cmd.icd.yaml`` -> ``dut_cmd``; ``None`` for other files."""
    return file_name[: -len(ICD_SUFFIX)] if file_name.endswith(ICD_SUFFIX) else None
