"""Contracts for the normalized public MCP gateway."""

from __future__ import annotations

from typing import Any
from urllib.parse import urldefrag, urljoin

from teststand_backend import CONTRACT_REVISION as CONTRACT_REVISION
from teststand_backend.util import clone

Record = dict[str, Any]


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

    visit(upstream, prefix, "https://teststand.invalid/upstream", rewrite=False)
    result = visit(upstream, prefix, "https://teststand.invalid/upstream", rewrite=True)
    assert isinstance(result, dict)
    return result


def _payload_schema(upstream: Record) -> Record:
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


def business_result_schema(upstream: Record | None) -> Record:
    """Return the schema for the value produced by ``call_remote``.

    MCP output schemas describe ``structuredContent``.  testStand unwraps a
    successful top-level ``data`` member at the transport boundary, so every
    in-process caller must validate the unwrapped value against this schema rather
    than validating it against the transport envelope a second time.
    """
    if not upstream:
        return {}
    payload = _payload_schema(upstream)
    result: Record = {"allOf": [clone(payload["allOf"][0])]}
    if payload.get("$defs"):
        result["$defs"] = clone(payload["$defs"])
    return result


def sdk_envelope_schema(structured_content: Record) -> Record:
    """Describe the MCP SDK response around validated structured content.

    This envelope is transport-only.  ``structuredContent`` is validated against
    the remote tool schema, while callers inside testStand receive the separately
    normalized business result.
    """
    embedded = _embedded_schema(structured_content)
    return {
        "type": "object",
        "properties": {
            "content": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string"},
                        "text": {"type": "string"},
                    },
                    "required": ["type"],
                    "additionalProperties": True,
                },
            },
            "structuredContent": {"$ref": "#/$defs/HHUpstream"},
        },
        "required": ["content", "structuredContent"],
        "additionalProperties": True,
        "$defs": {"HHUpstream": embedded},
    }


def public_remote_tool(tool: Record) -> Record:
    result = {
        "name": tool["externalName"],
        "description": tool.get("description", "Remote tool; read its contract before calling."),
        "inputSchema": clone(tool["inputSchema"]),
        "outputSchema": with_error_schema(
            normalized_output_schema(tool.get("upstreamOutputSchema"))
        ),
        "_meta": {
            "teststand": {
                **clone(tool.get("contractMetadata", {})),
                "contractRevision": CONTRACT_REVISION,
                "deviceId": tool["deviceId"],
                "toolName": tool["externalName"],
                "remoteToolName": tool["remoteName"],
                "kind": tool.get("kind", "unknown"),
                "resultMode": "data",
            }
        },
    }
    if tool.get("annotations"):
        result["annotations"] = clone(tool["annotations"])
    return result
