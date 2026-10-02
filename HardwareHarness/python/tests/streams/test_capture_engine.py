"""End to end: an Expect capture is visible to later steps as steps.<id>.captures (§7.5)."""

from __future__ import annotations

from pathlib import Path

from .test_engine_steps import invoke, plan_with, run


async def test_expect_capture_feeds_later_expressions(tmp_path: Path) -> None:
    plan = plan_with(
        invoke("ask", "send", "sent", reply="ERR CODE=42"),
        {
            "id": "answer",
            "type": "Expect",
            "hardwareId": "dev",
            "streamId": "rx",
            "anchor": "sent",
            "withinMs": 1000,
            "match": {"pattern": r"CODE=\d+"},
            "capture": {"code": {"regex": r"CODE=(\d+)"}},
        },
        {
            "id": "report",
            "type": "PublishResult",
            "name": "code",
            "valueExpression": "int(steps.answer.captures.code) + 1",
        },
    )
    engine, completed = await run(tmp_path, plan)
    results = engine.runs[completed["runId"]].results
    assert completed["verdict"] in {"Pass", "NotSet"}, results
    published = [item for item in results if item.get("name") == "code"]
    assert published and published[-1]["value"] == 43, results
    verdict = next(item for item in results if item.get("sourceStepId") == "answer")
    assert verdict["verdict"] == "Pass"
