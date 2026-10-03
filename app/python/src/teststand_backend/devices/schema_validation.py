"""JSON Schema checks for MCP tool arguments and structured results."""

from __future__ import annotations

from typing import Any

from jsonschema import Draft7Validator, FormatChecker, validators

Schema = dict[str, Any] | bool


def schema_error(schema: Schema, value: Any, *, validate_formats: bool = False) -> str | None:
    """Return every violation as ``data/<path> <message>`` joined by commas, or None."""
    validator_class = validators.validator_for(schema, default=Draft7Validator)
    validator = validator_class(
        schema, format_checker=FormatChecker() if validate_formats else None
    )
    errors = [
        "data" + "".join(f"/{part}" for part in error.absolute_path) + " " + error.message
        for error in validator.iter_errors(value)
    ]
    return ", ".join(errors) if errors else None
