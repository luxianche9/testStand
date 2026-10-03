import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Uses only the installed application's public MCP interface. No HH module imports or source reads.
// The caller must supply its own isolated, initialized project and test-only gateway credentials.
export async function verifyAgentInterface(endpoint, token) {
  const client = new Client({ name: "hardwareharness-release-contract-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.structuredContent ?? result.content)}`);
    assert.equal(result.structuredContent?.ok, true, `${name}: expected the public success envelope`);
    return result.structuredContent.data;
  };
  try {
    const instructions = client.getInstructions();
    assert.ok(instructions?.trim());
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of ["get_agent_context", "get_tool_contract", "read_reference", "get_execution_availability", "wait_for_status"]) {
      assert.ok(names.has(name), `Missing public release tool: ${name}`);
    }
    for (const tool of tools) {
      assert.ok(tool.description?.trim(), `Missing description: ${tool.name}`);
      assert.ok(tool.outputSchema, `Missing result schema: ${tool.name}`);
      assert.ok(!/python_run|test_flow|workspace|prepare_shutdown/.test(tool.name), `Retired/internal tool leaked: ${tool.name}`);
    }
    const context = await call("get_agent_context");
    const contract = await call("get_tool_contract", { toolName: "request_wiring_task" });
    assert.ok(contract);
    const index = await call("read_reference");
    assert.ok(index.references.length > 0);
    const referenceId = index.references.find((item) => item.referenceId === "hh-agent-interface")?.referenceId;
    assert.ok(referenceId, "The installed interface guide must be discoverable");
    let offset = 0;
    const lines = [];
    do {
      const page = await call("read_reference", { referenceId, offset, limit: 20 });
      lines.push(...page.lines);
      offset = page.nextOffset;
    } while (offset !== null);
    assert.ok(lines.some((line) => line.text.includes("get_tool_contract")));

    return {
      status: "passed", publicTools: tools.length, publicOnly: true, hardwareInvoked: false,
      liveModelAssessed: false, independentCleanWindowsVerified: false,
      runtimeContext: context, referenceLines: lines.length

    };
  } finally {
    await client.close();
  }
}
