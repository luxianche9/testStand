from typing import Any

from hardwareharness_backend.contracts.validation import enum, obj, parse_record, string, unknown
from hardwareharness_backend.util import UNDEFINED, Record

ERROR_CATEGORIES = (
    "permission_denied",
    "invalid_argument",
    "unavailable",
    "conflict",
    "not_found",
    "validation_failed",
    "requires_project",
    "safe_stop_failed",
    "invalid_response",
    "loop_limit",
    "assertion_failed",
    "project_exists",
    "invalid_project",
    "project_uninitialized",
    "invalid_project_folder",
    "cancelled",
    "error",
)
error_category_schema = enum(*ERROR_CATEGORIES)
wire_error_schema = obj(
    {"category": error_category_schema, "message": string(), "details": unknown().optional()}
)


class AppError(RuntimeError):
    name = "AppError"

    def __init__(self, category: str, message: str, details: Any = UNDEFINED) -> None:
        super().__init__(message)
        self.category = category
        self.details = details


def app_error(category: str, message: str, details: Any = UNDEFINED) -> AppError:
    return AppError(category, message, details)


def to_wire_error(error: Any) -> Record:
    candidate = (
        error if isinstance(error, dict) else vars(error) if hasattr(error, "__dict__") else {}
    )
    category = candidate.get("category", "error")
    message = candidate.get(
        "message", str(error) if isinstance(error, BaseException) else UNDEFINED
    )
    result = {
        "category": category if category in ERROR_CATEGORIES else "error",
        "message": message if isinstance(message, str) else str(error),
    }
    if "details" in candidate and candidate["details"] is not UNDEFINED:
        result["details"] = candidate["details"]
    return result


def parse_wire_error(value: Any) -> Record:
    return parse_record(wire_error_schema, value)
