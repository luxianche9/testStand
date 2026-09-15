"""Contracts for the normalized public gateway and the compatible Python SDK."""

from __future__ import annotations

from typing import Any
from urllib.parse import urldefrag, urljoin

from hardwareharness_backend.compat import clone

Record = dict[str, Any]
CONTRACT_REVISION = "2026-09-15.1"


def success_schema(data: Record | bool) -> Record:
    return {
        "type": "object",
        "properties": {"ok": {"const": True}, "data": data},
        "required": ["ok", "data"],
        "additionalProperties": False,
    }


def with_error_schema(success: Record) -> Record:
    """Add the gateway's actual error result without moving existing reference targets."""
    result = clone(success)
    properties = result.setdefault("properties", {})
    properties["ok"] = {"type": "boolean", "description": "Whether the operation succeeded."}
    properties["error"] = {
        "type": "object",
        "properties": {
            "category": {"type": "string", "description": "Stable failure category."},
            "message": {"type": "string", "description": "Human-readable failure explanation."},
            "details": {
                "description": "Optional structured recovery information or original detail."
            },
            "validationIssues": {
                "type": "array",
                "items": {"type": "object"},
                "description": "Input validation locations and failed constraints, when present.",
            },
        },
        "required": ["category", "message"],
        "additionalProperties": False,
        "description": "Failure and recovery information. isError=true accompanies this result.",
    }
    result["required"] = ["ok"]
    result["anyOf"] = [
        {
            "properties": {"ok": {"const": True}},
            "required": ["data"],
            "not": {"required": ["error"]},
        },
        {
            "properties": {"ok": {"const": False}},
            "required": ["error"],
            "not": {"required": ["data"]},
        },
    ]
    return result


def _embedded_schema(upstream: Record) -> Record:
    """Relocate local resource/pointer/anchor references into one wrapper definition."""
    prefix = "#/$defs/HHUpstream"
    roots: dict[str, str] = {}
    anchors: dict[str, str] = {}
    ignored = {"default", "examples", "const", "enum"}

    def absolute(base: str, ref: str) -> str:
        return urldefrag(base)[0] + ref if ref.startswith("#") else urljoin(base, ref)

    def visit(value: Any, path: str, base: str, *, rewrite: bool) -> Any:
        if isinstance(value, list):
            return [
                visit(item, f"{path}/{index}", base, rewrite=rewrite)
                for index, item in enumerate(value)
            ]
        if not isinstance(value, dict):
            return value
        if isinstance(value.get("$id"), str):
            base = absolute(base, value["$id"])
        if not rewrite:
            if path == prefix or "$id" in value:
                roots[urldefrag(base)[0]] = path
            for key in ("$anchor", "$dynamicAnchor"):
                if isinstance(value.get(key), str):
                    anchors[urldefrag(base)[0] + "#" + value[key]] = path
        output = {}
        for key, item in value.items():
            if key in ignored:
                output[key] = clone(item)
            elif rewrite and key in {"$id", "$anchor", "$dynamicAnchor"}:
                continue
            elif rewrite and key in {"$ref", "$dynamicRef"} and isinstance(item, str):
                target = absolute(base, item)
                resource, fragment = urldefrag(target)
                output[key] = (
                    roots[resource] + fragment
                    if resource in roots and fragment.startswith("/")
                    else roots[resource]
                    if resource in roots and not fragment
                    else anchors.get(target, target)
                )
            else:
                token = key.replace("~", "~0").replace("/", "~1")
                output[key] = visit(item, f"{path}/{token}", base, rewrite=rewrite)
        return output

    visit(upstream, prefix, "https://hardwareharness.invalid/upstream", rewrite=False)
    result = visit(upstream, prefix, "https://hardwareharness.invalid/upstream", rewrite=True)
    assert isinstance(result, dict)
    return result


def _payload_schema(upstream: Record, *, sdk: bool = False) -> Record:
    embedded = _embedded_schema(upstream)
    prefix = "#/$defs/HHUpstream"

    def payload(schema: Any, path: str, seen: frozenset[str] = frozenset()) -> Any:
        if isinstance(schema, bool):
            return schema
        ref = schema.get("$ref", "")
        if isinstance(ref, str) and ref.startswith(prefix) and ref not in seen:
            resolved: Any = embedded
            for key in ref[len(prefix) :].lstrip("/").split("/") if ref != prefix else []:
                token = key.replace("~1", "/").replace("~0", "~")
                resolved = resolved[int(token)] if isinstance(resolved, list) else resolved[token]
            return payload(resolved, ref, seen | {ref})
        for keyword in ("anyOf", "oneOf"):
            if keyword in schema:
                return {
                    "anyOf": [
                        payload(branch, f"{path}/{keyword}/{index}", seen)
                        for index, branch in enumerate(schema[keyword])
                    ]
                }
        # Composed schemas can spread the wrapper across multiple branches. Retain a truthful
        # permissive payload contract until a transformation can preserve all those constraints.
        if "allOf" in schema:
            return {}
        properties = schema.get("properties", {})
        if properties.get("ok", {}).get("const") is False:
            return False
        original = {"$ref": path}
        if "data" in properties:
            data = {"$ref": f"{path}/properties/data"}
            if sdk and properties.get("ok", {}).get("const") is not True:
                return {"anyOf": [data, original]}
            return data if "data" in schema.get("required", []) else {"anyOf": [data, original]}
        return original

    return {"allOf": [payload(embedded, prefix)], "$defs": {"HHUpstream": embedded}}


def normalized_output_schema(upstream: Record | None) -> Record:
    """Match call_remote: unwrap a top-level data field, retaining local references."""
    if not upstream:
        return success_schema({"description": "Upstream structured data or MCP content blocks."})

    payload = _payload_schema(upstream)
    result = success_schema(payload["allOf"][0])
    result["$defs"] = payload["$defs"]
    return result


def sdk_data_schema(upstream: Record | None) -> Record:
    """Standalone schema for SDK result_mode=data, retaining its reference document."""
    return _payload_schema(upstream, sdk=True) if upstream else {}


def public_remote_tool(tool: Record) -> Record:
    result = {
        "name": tool["externalName"],
        "description": tool.get("description", "Remote tool; read its contract before calling."),
        "inputSchema": clone(tool["inputSchema"]),
        "outputSchema": with_error_schema(
            normalized_output_schema(tool.get("upstreamOutputSchema"))
        ),
        "_meta": {
            "hardwareharness": {
                **clone(tool.get("contractMetadata", {})),
                "contractRevision": CONTRACT_REVISION,
                "serverId": tool["serverId"],
                "sdkToolName": tool["externalName"],
                "remoteToolName": tool["remoteName"],
                "kind": tool.get("kind", "unknown"),
                "resultMode": "data",
                "sdkDefaultResultMode": "envelope",
            }
        },
    }
    if tool.get("annotations"):
        result["annotations"] = clone(tool["annotations"])
    return result


def sdk_envelope_schema(upstream: Record | None) -> Record:
    result = {
        "type": "object",
        "properties": {
            "content": {"type": "array", "items": {"type": "object"}},
            "structuredContent": {"$ref": "#/$defs/HHUpstream"} if upstream else {"type": "object"},
            "isError": {"type": "boolean"},
        },
        "required": ["content"],
    }
    if upstream:
        result["$defs"] = {"HHUpstream": _embedded_schema(upstream)}
    return result
