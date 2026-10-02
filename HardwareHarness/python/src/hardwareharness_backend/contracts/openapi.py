"""OpenAPI 3.1 description of the operation registry (design doc §9.4).

Each operation is ``POST /api/ops/{name}`` with its request model as the JSON body. The
registry metadata rides along as extensions: ``x-risk``, ``x-capability``, ``x-profiles``,
``x-idempotency`` and ``x-confirm``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from .operations import OperationDefinition

Record = dict[str, Any]
COMPONENTS = "#/components/schemas/"


def openapi_document(definitions: Mapping[str, OperationDefinition], version: str) -> Record:
    schemas: Record = {"WireError": _wire_error()}
    paths: Record = {}
    for name in sorted(definitions):
        definition = definitions[name]
        request = _hoist(
            definition.request.model_json_schema(
                by_alias=True, ref_template=COMPONENTS + "{model}"
            ),
            schemas,
        )
        schemas[definition.request.__name__] = request
        response = _hoist(definition.response_schema, schemas)
        spec = definition.spec
        paths[f"/api/ops/{name}"] = {
            "post": {
                "operationId": name,
                "summary": definition.summary or name,
                "tags": [definition.namespace],
                "requestBody": {
                    "required": bool(request.get("required")),
                    "content": {
                        "application/json": {
                            "schema": {"$ref": COMPONENTS + definition.request.__name__}
                        }
                    },
                },
                "responses": {
                    "200": {"content": {"application/json": {"schema": response}}},
                    "default": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {"error": {"$ref": COMPONENTS + "WireError"}},
                                    "required": ["error"],
                                }
                            }
                        }
                    },
                },
                "x-risk": spec.risk,
                "x-capability": spec.capability,
                "x-profiles": sorted(spec.profiles),
                "x-idempotency": spec.idempotency,
                "x-confirm": spec.confirm,
            }
        }
    return {
        "openapi": "3.1.0",
        "info": {"title": "HardwareHarness service", "version": version},
        "components": {
            "schemas": dict(sorted(schemas.items())),
            "securitySchemes": {"bearer": {"type": "http", "scheme": "bearer"}},
        },
        "security": [{"bearer": []}],
        "paths": paths,
    }


def _hoist(schema: Record, schemas: Record) -> Record:
    """Move ``$defs`` into the shared components and point the references there."""
    text = json.dumps(schema).replace('"#/$defs/', '"' + COMPONENTS)
    result: Record = json.loads(text)
    for key, value in result.pop("$defs", {}).items():
        schemas.setdefault(key, value)
    return result


def _wire_error() -> Record:
    return {
        "type": "object",
        "properties": {
            "category": {"type": "string"},
            "message": {"type": "string"},
            "details": {},
        },
        "required": ["category", "message"],
    }
