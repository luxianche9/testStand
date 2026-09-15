from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from jsonschema import Draft202012Validator

from hardwareharness_backend.application import DefaultAuthorizer
from hardwareharness_backend.automation.service import AutomationService
from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.contracts.validation import ValidationError, parse_record
from hardwareharness_backend.mcp_gateway.agent_services import (
    AGENT_ARGUMENT_SCHEMAS,
    AGENT_TOOL_DEFINITIONS,
    invoke_agent_tool,
)

from ..application.test_applications import fixture

AGENT = {"actor": "agent", "source": "mcp"}


async def invoke(app: Any, name: str, value: Any = None) -> Any:
    inputs = parse_record(AGENT_ARGUMENT_SCHEMAS[name], value or {})
    output = await invoke_agent_tool(app, AGENT, name, inputs)
    definition = next(
        item["tool"] for item in AGENT_TOOL_DEFINITIONS if item["tool"]["name"] == name
    )
    Draft202012Validator(definition["outputSchema"]).validate({"ok": True, "data": output})
    return output


def test_new_tool_contracts_have_descriptions_output_schemas_and_bounded_inputs() -> None:
    for definition in AGENT_TOOL_DEFINITIONS:
        tool = definition["tool"]
        Draft202012Validator.check_schema(tool["inputSchema"])
        Draft202012Validator.check_schema(tool["outputSchema"])
        assert tool["annotations"]["destructiveHint"] is False
        assert all(prop.get("description") for prop in tool["inputSchema"]["properties"].values())
    with pytest.raises(ValidationError):
        parse_record(
            AGENT_ARGUMENT_SCHEMAS["wait_for_status"],
            {"kind": "run", "id": "R", "timeoutMs": 30001},
        )


async def test_context_without_project_and_document_reads_use_only_bundled_contract() -> None:
    app = SimpleNamespace(
        projects=SimpleNamespace(document=lambda context: None), authorizer=DefaultAuthorizer()
    )
    context = await invoke(app, "get_agent_context")
    assert context["project"] is None and context["environment"]["status"] == "no_project"
    assert context["contractRevision"] == "2026-09-15.1"
    assert context["references"][0]["referenceId"] == "hh-sdk"
    page = await invoke(app, "read_reference", {"referenceId": "hh-sdk", "query": "result_mode"})
    assert page["lines"]


async def test_public_script_create_run_wait_sources_and_artifact_roundtrip(tmp_path: Path) -> None:
    applications, devices = await fixture(tmp_path)
    applications.runner.python_provider = AsyncMock(return_value=sys.executable)
    app = SimpleNamespace(applications=applications)
    source = (
        "from pathlib import Path\n"
        "from hardwareharness import attachment, log\n"
        "def main(inputs):\n"
        "    for i in range(6): log(str(i))\n"
        "    p = Path('evidence.bin')\n"
        "    p.write_bytes(bytes(range(256)))\n"
        "    attachment(p)\n"
        "    return {'passed': False, 'reason': 'explicit business result'}\n"
    )
    try:
        created = await invoke(
            app, "create_workspace_file", {"path": "scripts/main.py", "content": source}
        )
        assert created["hash"] == hashlib.sha256(source.encode()).hexdigest()
        with pytest.raises(AppError, match="already exists"):
            await invoke(
                app, "create_workspace_file", {"path": "scripts/main.py", "content": "replacement"}
            )
        run = await applications.start_run(
            AGENT, {"entrypoint": "scripts/main.py", "inputs": {}, "hardwareIds": []}
        )
        run_id = run["runId"]
        terminal = await invoke(
            app, "wait_for_status", {"kind": "run", "id": run_id, "timeoutMs": 5000}
        )
        while not terminal["terminal"]:
            terminal = await invoke(
                app,
                "wait_for_status",
                {"kind": "run", "id": run_id, "revision": terminal["revision"], "timeoutMs": 5000},
            )
        summary = await invoke(app, "get_python_run_summary", {"runId": run_id, "limit": 1})
        assert summary["run"]["status"] == "succeeded"
        assert summary["run"]["result"]["passed"] is False
        assert summary["hasMore"] and summary["nextAfter"] == 1
        # The attachment comes after the requested event page and is still discoverable.
        artifact_id = summary["artifacts"][0]["artifactId"]
        page1 = await invoke(
            app,
            "read_python_run_artifact",
            {"runId": run_id, "artifactId": artifact_id, "limit": 100},
        )
        page2 = await invoke(
            app,
            "read_python_run_artifact",
            {"runId": run_id, "artifactId": artifact_id, "offset": page1["nextOffset"]},
        )
        assert base64.b64decode(page1["contentBase64"]) + base64.b64decode(
            page2["contentBase64"]
        ) == bytes(range(256))
        assert page2["hasMore"] is False
        saved = await invoke(
            app, "read_python_run_source", {"runId": run_id, "path": "scripts/main.py", "limit": 20}
        )
        assert saved["content"] == source[:20] and saved["hasMore"]
        with pytest.raises(AppError, match="snapshot"):
            await invoke(app, "read_python_run_source", {"runId": run_id, "path": "../../outside"})
        result = await invoke(
            app, "read_python_run_artifact", {"runId": run_id, "artifactId": "run-result"}
        )
        assert json.loads(base64.b64decode(result["contentBase64"]))["passed"] is False
        devices.call_tool.assert_not_awaited()
    finally:
        await applications.close()


async def test_compact_large_result_keeps_full_json_evidence(tmp_path: Path) -> None:
    runner = AutomationService(lambda: str(tmp_path))
    store = runner._store()
    record: dict[str, Any] = {
        "runId": "R",
        "status": "succeeded",
        "startedAt": "2026-09-15T00:00:00Z",
        "eventCount": 0,
        "result": {"value": "x" * 8000},
        "sourceHashes": {},
    }
    store.save(record)
    applications = SimpleNamespace(
        get_run=lambda context, run_id: runner.get_run(run_id),
        run_events=lambda context, *args: runner.run_events(*args),
    )
    app = SimpleNamespace(applications=applications)
    summary = await invoke(app, "get_python_run_summary", {"runId": "R"})
    assert summary["run"]["result"]["artifactId"] == "run-result"
    artifact = await invoke(
        app, "read_python_run_artifact", {"runId": "R", "artifactId": "run-result"}
    )
    assert json.loads(base64.b64decode(artifact["contentBase64"])) == record["result"]


async def test_effective_availability_accounts_for_holders_and_disabled_server() -> None:
    dashboard: dict[str, Any] = {
        "execution": {"state": "run", "runId": "R", "hardwareIds": ["H"]},
        "availability": [{"hardwareId": "H", "state": "available", "checkedAt": "old"}],
        "servers": [{"serverId": "S", "enabled": True}],
    }
    app = SimpleNamespace(
        system=SimpleNamespace(dashboard=lambda context: dashboard),
        devices=SimpleNamespace(
            list_hardware=lambda context: [{"hardwareId": "H", "kind": "managed", "serverId": "S"}]
        ),
    )
    output = await invoke(app, "get_execution_availability")
    assert output["hardware"][0]["available"] is False
    assert output["hardware"][0]["holders"][0]["runId"] == "R"
    dashboard["execution"] = {"state": "idle"}
    dashboard["servers"][0]["enabled"] = False
    output = await invoke(app, "get_execution_availability")
    assert output["hardware"][0]["busyReason"] == "server_disabled_or_missing"


async def test_wait_is_bounded_and_detects_existing_wiring_change() -> None:
    status = {"wiringTaskId": "W", "status": "pending"}
    app = SimpleNamespace(wiring=SimpleNamespace(get_task=lambda context, id: dict(status)))
    first = await invoke(app, "wait_for_status", {"kind": "wiring", "id": "W", "timeoutMs": 0})
    assert first["timedOut"] and not first["changed"]
    pending = asyncio.create_task(
        invoke(
            app,
            "wait_for_status",
            {"kind": "wiring", "id": "W", "revision": first["revision"], "timeoutMs": 500},
        )
    )
    await asyncio.sleep(0)
    status["status"] = "confirmed"
    done = await pending
    assert done["changed"] and done["terminal"] and not done["timedOut"]
