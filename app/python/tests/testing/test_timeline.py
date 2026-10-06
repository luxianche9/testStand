from typing import Any

from teststand_backend.testing.timeline import RESULT_PREVIEW_CHARS, attach_call_results


def test_calls_take_the_result_and_final_state_of_their_operation() -> None:
    calls: list[dict[str, Any]] = [
        {"operationId": "op-1", "state": "dispatched"},
        {"operationId": "op-2", "state": "dispatched"},
        {"operationId": "op-3", "state": "accepted"},
    ]
    operations = [
        {"operationId": "op-1", "state": "succeeded", "result": {"value": 3.3}},
        {"operationId": "op-2", "state": "failed", "result": {"error": {"message": "timeout"}}},
    ]
    attach_call_results(calls, operations)
    assert calls[0] == {"operationId": "op-1", "state": "succeeded", "result": {"value": 3.3}}
    assert calls[1]["state"] == "failed" and calls[1]["result"]["error"]["message"] == "timeout"
    assert calls[2] == {"operationId": "op-3", "state": "accepted"}


def test_a_bulky_result_is_cut_to_a_preview() -> None:
    calls: list[dict[str, Any]] = [{"operationId": "op-1", "state": "dispatched"}]
    bulky = {"operationId": "op-1", "state": "succeeded", "result": list(range(5000))}
    attach_call_results(calls, [bulky])
    result = calls[0]["result"]
    assert result["truncated"] is True and len(result["preview"]) == RESULT_PREVIEW_CHARS
