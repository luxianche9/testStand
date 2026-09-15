"""Exercise the actual MCP registration/serialization boundary without device access."""
import asyncio
import importlib
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import jsonschema
import pytest


def validate_contract(tool, response):
    jsonschema.validate(response, tool.outputSchema)
    # Development integration check. Runtime service code never imports HH source.
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
def server(tmp_path, monkeypatch):
    service = Path(__file__).resolve().parents[2]
    config = json.loads((service / "server.example.json").read_text(encoding="utf-8"))
    config.update(port=18001, token="test-only-token" * 3)
    path = tmp_path / "server.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    monkeypatch.setenv("HARDWAREHARNESS_SERVER_CONFIG", str(path))
    import hardwareharness_remote.server as module
    return importlib.reload(module)


def test_every_public_tool_has_executable_fields_and_result_schema(server):
    async def run():
        tools = await server.mcp.list_tools()
        public = [tool for tool in tools if tool.meta["hardwareharness"]["kind"] != "internal"]
        expected = {"CP118U_I_MCP": 11, "PCI1710L_MCP": 9, "PCI6208V_MCP": 7, "PCI1762_MCP": 8}
        assert len(public) == expected[server.config["serverId"]]
        assert sum(tool.meta["hardwareharness"]["kind"] == "internal" for tool in tools) == 1
        for tool in public:
            assert len(tool.description) > 80, tool.name
            assert tool.outputSchema and "data" in tool.outputSchema["properties"], tool.name
            assert tool.annotations is not None
            assert "execution" not in tool.model_dump(exclude_none=True)
            assert tool.meta["hardwareharness"]["contractRevision"] == "2026-09-15.1"
            for field in tool.inputSchema["properties"].values():
                assert field.get("description"), (tool.name, field)
            jsonschema.Draft202012Validator.check_schema(tool.outputSchema)
        by_name = {tool.name: tool for tool in public}
        for name, args in [("get_server_info", {}), ("list_hardware", {}),
                           ("get_hardware_info", {"hardwareId": server.config["hardwareId"]}),
                           ("get_pinout", {"hardwareId": server.config["hardwareId"], "limit": 2})]:
            _, data = await server.mcp.call_tool(name, args)
            assert data["ok"], data
            validate_contract(by_name[name], data)
            if name != "get_pinout":
                assert "error" not in data  # optional nulls must not change the existing envelope
        assert "token" not in json.dumps(server.get_server_info()["data"])
    asyncio.run(run())


SAMPLES = {
    "pci1710l_configure_ai": ({"channel": 0}, {"channel": 0, "signal_type": 0, "value_range": 1, "signal": "SingleEnded"}),
    "pci1710l_read_voltage": ({"channel": 0}, {"channel": 0, "volts": 1.25, "raw": 123, "signal": "SingleEnded", "value_range": 1}),
    "pci1710l_read_bit": ({"channel": 0}, {"channel": 0, "kind": "DI", "value": False}),
    "pci1710l_set_level": ({"channel": 0, "level": False}, {"channel": 0, "level": False}),
    "pci1710l_safe_state": ({}, {"safe_do_mask": 5}),
    "pci1762_set_relay": ({"channel": 0, "closed": True}, {"channel": 0, "closed": True, "port": 0, "bit": 0}),
    "pci1762_set_bank": ({"mask": 3}, {"mask": 3}),
    "pci1762_read_bit": ({"channel": 0}, {"channel": 0, "kind": "DI", "value": False}),
    "pci1762_safe_state": ({}, {"relays": "all_open"}),
    "pci6208v_set_voltage": ({"channel": 0, "volts": 1.25}, {"channel": 0, "volts": 1.25}),
    "pci6208v_read_last": ({"channel": 0}, {"channel": 0, "volts": 1.25}),
    "pci6208v_safe_state": ({}, {"safe_volts": 2.0}),
    "cp118u_configure_port": ({"channel": 1}, {"channel": 1, "port": 3, "baud": 9600, "mode": 3, "flow": 0, "flow_rc": 0}),
    "cp118u_write_text": ({"channel": 1, "text": "hello"}, {"channel": 1, "bytes": 5}),
    "cp118u_write_hex": ({"channel": 1, "hex_data": "FF 00"}, {"channel": 1, "bytes": 2}),
    "cp118u_read_rx": ({"channel": 1}, {"channel": 1, "bytes": 2, "hex": "ff 00", "text": "\ufffd\u0000"}),
    "cp118u_clear_rx": ({"channel": 1}, {"channel": 1}),
    "cp118u_flush": ({"channel": 1}, {"channel": 1, "what": "both"}),
    "cp118u_get_line_status": ({"channel": 1}, {"channel": 1, "port": 3, "baud": 9600, "frame": "8N1", "mode": 3, "flow": 0, "lstatus": 0}),
}


def test_hardware_success_failure_and_invalid_inputs_use_real_mcp_boundary(server, monkeypatch):
    async def run():
        tools = {tool.name: tool for tool in await server.mcp.list_tools()}
        invoke = AsyncMock()
        monkeypatch.setattr(server.manager, "invoke", invoke)
        for name, (arguments, expected) in SAMPLES.items():
            if name not in tools:
                continue
            invoke.return_value = {**expected, "vendorEvidence": "retained"}
            invoke.side_effect = None
            _, result = await server.mcp.call_tool(name, {"hardwareId": server.config["hardwareId"], **arguments})
            assert result["data"] == {**expected, "vendorEvidence": "retained"}
            assert "error" not in result
            validate_contract(tools[name], result)
            invoke.side_effect = server.AdapterError("partial effect", details={"failedChannels": [0]})
            _, failure = await server.mcp.call_tool(name, {"hardwareId": server.config["hardwareId"], **arguments})
            assert not failure["ok"] and failure["error"]["details"] == {"failedChannels": [0]}
            assert "data" not in failure
            validate_contract(tools[name], failure)
        invoke.reset_mock()
        invalid_name = next(name for name, (_, _) in SAMPLES.items() if name in tools and "channel" in tools[name].inputSchema["properties"])
        args = {"hardwareId": server.config["hardwareId"], **SAMPLES[invalid_name][0], "channel": 99}
        with pytest.raises(Exception, match="less than or equal"):
            await server.mcp.call_tool(invalid_name, args)
        invoke.assert_not_awaited()
    asyncio.run(run())
