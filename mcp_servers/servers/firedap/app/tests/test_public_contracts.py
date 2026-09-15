import asyncio
import base64
import hashlib
import json
import importlib.util
import sys
from pathlib import Path

import jsonschema
import pytest

from hardwareharness_firedap.firmware import FLASH_START, OperationError, configure_firmware_storage, import_firmware, inspect_firmware
from hardwareharness_firedap.server import create_app


def validate_contract(tool, response):
    jsonschema.validate(response, tool.outputSchema)
    source = Path(__file__).resolve().parents[5] / "HardwareHarness" / "python" / "src"
    if not source.is_dir():
        return
    sys.path.insert(0, str(source))
    spec = importlib.util.spec_from_file_location("gateway_public_contract_check", source / "hardwareharness_backend/mcp_gateway/public_contracts.py")
    contract = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(contract)
    if response["ok"]:
        jsonschema.validate({"ok": True, "data": response["data"]}, contract.normalized_output_schema(tool.outputSchema))
    jsonschema.validate({"content": [{"type": "text", "text": json.dumps(response)}], "structuredContent": response}, contract.sdk_envelope_schema(tool.outputSchema))
    advertised = contract.public_remote_tool({"externalName": "TEST__" + tool.name, "remoteName": tool.name,
        "serverId": "TEST", "inputSchema": tool.inputSchema, "upstreamOutputSchema": tool.outputSchema,
        "description": tool.description, "execution": {"taskSupport": "required"}})
    assert "execution" not in advertised and "taskSupport" not in json.dumps(advertised)


@pytest.fixture
def app(tmp_path):
    pack = tmp_path / "target.pack"
    pack.write_bytes(b"contract-test-placeholder")
    ref = Path(__file__).resolve().parents[4] / "hardware-manuals" / "stm32-batianhu-v2"
    return create_app({"host": "127.0.0.1", "port": 18002, "token": "test-token-" * 4,
        "serverId": "FIREDAP_MCP", "computerId": "LOCAL", "hardwareId": "LOCAL_MCP.FIREDAP_0", "probeSerial": "test",
        "frequencyHz": 1000000, "packPath": str(pack), "pinoutPath": str(ref / "firedap.pinout.json"),
        "firmwareRoots": [], "jobDirectory": str(tmp_path / "jobs")})


def test_every_public_schema_and_reference_pagination(app):
    async def run():
        tools = await app.state.mcp.list_tools()
        public = [tool for tool in tools if tool.meta["hardwareharness"]["kind"] != "internal"]
        assert len(public) == 15
        assert sum(tool.meta["hardwareharness"]["kind"] == "internal" for tool in tools) == 1
        by_name = {tool.name: tool for tool in public}
        for tool in public:
            assert len(tool.description) > 80 and tool.outputSchema
            assert "data" in tool.outputSchema["properties"]
            assert tool.annotations is not None
            assert "execution" not in tool.model_dump(exclude_none=True)
            for field in tool.inputSchema["properties"].values():
                assert field.get("description"), (tool.name, field)
            jsonschema.Draft202012Validator.check_schema(tool.outputSchema)
        assert by_name["firedap_wait_job"].meta["hardwareharness"]["kind"] == "management"
        assert by_name["firedap_verify"].annotations.idempotentHint is False
        for name, args in [("get_server_info", {}), ("get_hardware_info", {"hardwareId": "LOCAL_MCP.FIREDAP_0"}),
                           ("get_pinout", {"hardwareId": "LOCAL_MCP.FIREDAP_0", "limit": 2}),
                           ("firedap_get_board_reference", {}), ("firedap_get_board_reference", {"section": "index"}),
                           ("firedap_get_board_reference", {"section": "ports", "limit": 2})]:
            _, result = await app.state.mcp.call_tool(name, args)
            assert result["ok"], result
            assert "error" not in result
            validate_contract(by_name[name], result)
            if args.get("section") == "ports":
                assert len(result["data"]["items"]) == 2 and result["data"]["nextOffset"] == 2
            if name == "get_server_info":
                assert "token" not in json.dumps(result["data"])
    asyncio.run(run())


def test_import_inspect_mcp_chain_and_hash_conflicts(app, tmp_path):
    async def run():
        raw = b"\x00\xff\x01\x02"
        digest = hashlib.sha256(raw).hexdigest()
        args = {"filename": "firmware.bin", "content_base64": base64.b64encode(raw).decode(), "expected_sha256": digest}
        _, imported = await app.state.mcp.call_tool("firedap_import_firmware", args)
        assert imported["ok"] and imported["data"]["immutable"]
        path = imported["data"]["path"]
        assert Path(path).read_bytes() == raw
        _, again = await app.state.mcp.call_tool("firedap_import_firmware", args)
        assert again["data"]["artifactId"] == imported["data"]["artifactId"]
        _, inspected = await app.state.mcp.call_tool("firedap_inspect_firmware", {"path": path, "base_address": FLASH_START})
        assert inspected["ok"] and inspected["data"]["sha256"] == digest
        _, mismatch = await app.state.mcp.call_tool("firedap_import_firmware", {**args, "expected_sha256": "0" * 64})
        assert not mismatch["ok"] and Path(path).read_bytes() == raw
        assert not app.state.runtime.jobs  # import/reference paths never submit hardware jobs
        tools = {tool.name: tool for tool in await app.state.mcp.list_tools()}
        for name, result in [("firedap_import_firmware", imported), ("firedap_import_firmware", mismatch), ("firedap_inspect_firmware", inspected)]:
            validate_contract(tools[name], result)
    asyncio.run(run())


def test_all_firedap_tools_return_advertised_results_through_gateway_normalization(app):
    async def run():
        async def worker(request, timeout):
            operation = request["operation"]
            if operation == "list_probes":
                return {"probes": [{"serialNumber": "test", "vendor": "Embedfire", "product": "FireDAP"}]}
            identity = {"probeSerial": "test", "target": "stm32f407zg", "deviceId": "0x413", "flashKiB": 1024,
                        "uid": ["0x1", "0x2", "0x3"], "identityLimit": "chip group only"}
            if operation in {"flash", "verify"}:
                return {**identity, "verified": True, "verifiedBytes": 4, "programmed": operation == "flash", "reset": operation == "flash"}
            if operation == "reset":
                return {**identity, "reset": True}
            if operation == "read_sram":
                return {**identity, "coreState": "RUNNING", "address": request["readAddress"], "length": request["readLength"], "words": [1]}
            return {**identity, "coreState": "RUNNING"}
        app.state.runtime.runner = worker
        tools = {tool.name: tool for tool in await app.state.mcp.list_tools() if tool.meta["hardwareharness"]["kind"] != "internal"}
        observed = set()
        async def call(name, args):
            _, response = await app.state.mcp.call_tool(name, args)
            assert response["ok"], response
            validate_contract(tools[name], response)
            observed.add(name)
            return response["data"]
        hid = {"hardwareId": "LOCAL_MCP.FIREDAP_0"}
        for name, args in [("get_server_info", {}), ("list_hardware", {}), ("get_hardware_info", hid),
                           ("get_pinout", hid), ("firedap_list_probes", {}), ("firedap_get_board_reference", {"section": "index"})]:
            await call(name, args)
        raw = b"abcd"
        imported = await call("firedap_import_firmware", {"filename": "firmware.bin", "content_base64": base64.b64encode(raw).decode(), "expected_sha256": hashlib.sha256(raw).hexdigest()})
        firmware = await call("firedap_inspect_firmware", {"path": imported["path"], "base_address": FLASH_START})
        for name, args in [("firedap_flash", {"path": firmware["path"], "base_address": FLASH_START, "expected_sha256": firmware["sha256"]}),
                           ("firedap_verify", {"path": firmware["path"], "base_address": FLASH_START, "expected_sha256": firmware["sha256"]}),
                           ("firedap_target_info", {}), ("firedap_reset", {}), ("firedap_read_sram", {"address": 0x20000000, "length": 4})]:
            job = await call(name, {**hid, **args})
            final = await call("firedap_wait_job", {**hid, "job_id": job["jobId"], "timeout_seconds": 1})
            assert final["state"] == "succeeded"
            await call("firedap_get_job", {"job_id": job["jobId"]})
        assert observed == set(tools)
    asyncio.run(run())


@pytest.mark.parametrize("filename,encoded,digest", [
    ("../x.bin", "AAAA", "0" * 64), ("C:\\x.bin", "AAAA", "0" * 64), ("x.exe", "AAAA", "0" * 64),
    ("x.bin", "not base64", "0" * 64), ("x.bin", "AAAA", "not-a-hash"), ("x.bin", "", "0" * 64),
])
def test_import_invalid_input_never_creates_artifact(tmp_path, filename, encoded, digest):
    root = tmp_path / "staging"
    with pytest.raises(OperationError):
        import_firmware(filename, encoded, digest, str(root))
    assert not root.exists()


def test_import_corrupt_existing_file_never_overwrites(tmp_path):
    raw = b"1234"
    digest = hashlib.sha256(raw).hexdigest()
    path = tmp_path / (digest + ".bin")
    path.write_bytes(b"corrupt")
    with pytest.raises(OperationError, match="corrupt"):
        import_firmware("x.bin", base64.b64encode(raw).decode(), digest, str(tmp_path))
    assert path.read_bytes() == b"corrupt"
    assert not list(tmp_path.glob(".import-*"))


def test_wait_queries_original_job_and_publishes_terminal_schema(app):
    async def run():
        async def worker(request, timeout):
            return {"target": "stm32f407zg", "coreState": "RUNNING"}
        app.state.runtime.runner = worker
        _, submitted = await app.state.mcp.call_tool("firedap_target_info", {"hardwareId": "LOCAL_MCP.FIREDAP_0"})
        job_id = submitted["data"]["jobId"]
        _, finished = await app.state.mcp.call_tool("firedap_wait_job", {"hardwareId": "LOCAL_MCP.FIREDAP_0", "job_id": job_id, "timeout_seconds": 1})
        assert finished["data"]["state"] == "succeeded" and finished["data"]["revision"] == 2
        assert len(app.state.runtime.jobs) == 1
        schema = next(tool.outputSchema for tool in await app.state.mcp.list_tools() if tool.name == "firedap_wait_job")
        jsonschema.validate(finished, schema)
        _, unknown = await app.state.mcp.call_tool("firedap_get_job", {"job_id": "previous-session"})
        assert unknown["error"]["category"] == "job_not_found"
        jsonschema.validate(unknown, schema)
    asyncio.run(run())
