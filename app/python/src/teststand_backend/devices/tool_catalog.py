"""Tool catalog entries and tool results, shared by the device transports.

A device describes its tools as MCP ``tools/list`` entries; :func:`catalog_entry` turns one
into the backend's aggregated catalog item (``<deviceId>__<tool>``) plus its validators.
:func:`unwrap_result` turns the SDK envelope ``{ok, data|error, meta}`` into the tool's data
(or ``{data, meta}``) and a failed envelope into an :class:`AppError` carrying its meta.
"""

from __future__ import annotations

from typing import Any

from jsonschema import Draft7Validator

from teststand_backend.contracts.errors import app_error
from teststand_backend.util import clone

from .schema_validation import schema_error

Record = dict[str, Any]

CONTRACT_KEYS = frozenset(
    {
        "kind",
        "contractRevision",
        "resultSemantics",
        "timeoutRecovery",
        "referenceIds",
        "evidence",
        "operationSemantics",
    }
)


def catalog_entry(device_id: str, raw: Record) -> tuple[Record, Record]:
    """``(catalog item, validators)`` of one ``tools/list`` entry; schemas are checked."""
    schema = raw["inputSchema"]
    Draft7Validator.check_schema(schema)
    inject = isinstance(schema.get("properties"), dict) and "hardwareId" in schema["properties"]
    validators: Record = {"input": schema, "injectHardwareId": inject}
    if raw.get("outputSchema"):
        Draft7Validator.check_schema(raw["outputSchema"])
        validators["output"] = raw["outputSchema"]
    public_schema = clone(schema)
    if inject:
        public_schema["properties"].pop("hardwareId", None)
        if isinstance(public_schema.get("required"), list):
            public_schema["required"] = [
                key for key in public_schema["required"] if key != "hardwareId"
            ]
    contract = raw.get("_meta", {}).get("teststand", {})
    kind = contract.get("kind", "unknown")
    entry = {
        "externalName": f"{device_id}__{raw['name']}",
        "remoteName": raw["name"],
        "deviceId": device_id,
        **({"description": raw["description"]} if raw.get("description") else {}),
        "inputSchema": public_schema,
        "kind": kind if isinstance(kind, str) else "unknown",
        **({"upstreamOutputSchema": clone(raw["outputSchema"])} if raw.get("outputSchema") else {}),
        **({"annotations": clone(raw["annotations"])} if raw.get("annotations") else {}),
        "contractMetadata": {
            key: clone(value) for key, value in contract.items() if key in CONTRACT_KEYS
        },
    }
    return entry, validators


def request_arguments(validators: Record | None, args: Record, metadata: Record | None) -> Record:
    """``args`` plus the bound ``hardwareId`` when the tool takes one."""
    if validators and validators["injectHardwareId"] and metadata and metadata.get("hardwareId"):
        return {**args, "hardwareId": metadata["hardwareId"]}
    return args


def unwrap_result(name: str, structured: Any, validators: Record | None, options: Record) -> Any:
    """The data of a successful envelope; a failed one raises :class:`AppError`."""
    if validators and validators.get("output") and structured is not None:
        error = schema_error(validators["output"], structured)
        if error:
            raise app_error("invalid_response", f"Invalid structuredContent from {name}: {error}")
    if isinstance(structured, dict) and structured.get("ok") is False:
        remote_error = structured.get("error") or {}
        failure = app_error(
            remote_error.get("category", "error"),
            remote_error.get("message", "Remote MCP tool failed"),
            remote_error.get("details"),
        )
        if isinstance(structured.get("meta"), dict):
            failure.meta = structured["meta"]
        raise failure
    if isinstance(structured, dict) and "data" in structured:
        data, meta = structured["data"], structured.get("meta")
    else:
        data, meta = structured, None
    if options.get("envelope"):
        return {"data": data, "meta": meta if isinstance(meta, dict) else {}}
    return data
