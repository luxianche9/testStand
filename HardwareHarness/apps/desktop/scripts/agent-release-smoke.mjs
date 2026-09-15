import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
    for (const name of ["get_agent_context", "get_tool_contract", "read_reference", "create_workspace_file", "get_execution_availability", "get_python_run_summary", "read_python_run_source", "read_python_run_artifact", "wait_for_status", "import_firmware_artifact"]) {
      assert.ok(names.has(name), `Missing public release tool: ${name}`);
    }
    for (const tool of tools) {
      assert.ok(tool.description?.trim(), `Missing description: ${tool.name}`);
      assert.ok(tool.outputSchema, `Missing result schema: ${tool.name}`);
      assert.ok(!tool.name.includes("prepare_shutdown"), `Internal tool leaked: ${tool.name}`);
    }
    const context = await call("get_agent_context");
    const contract = await call("get_tool_contract", { toolName: "start_python_run" });
    assert.ok(contract);
    const index = await call("read_reference");
    assert.ok(index.references.length > 0);
    const referenceId = index.references.find((item) => item.referenceId === "hh-sdk")?.referenceId;
    assert.ok(referenceId, "The installed SDK guide must be discoverable");
    let offset = 0;
    const lines = [];
    do {
      const page = await call("read_reference", { referenceId, offset, limit: 20 });
      lines.push(...page.lines);
      offset = page.nextOffset;
    } while (offset !== null);
    assert.ok(lines.some((line) => line.text.includes("result_mode")));

    const path = `scripts/release_${randomUUID().replaceAll("-", "")}.py`;
    const content = "from pathlib import Path\nfrom tempfile import TemporaryDirectory\n\nfrom hardwareharness import attachment, log, measurement, step\n\n\ndef main(inputs: dict[str, list[int]]) -> dict[str, int | bool]:\n    with step('public interface'):\n        for index in range(35):\n            log('sample', fields={'index': index})\n        total = sum(inputs['values'])\n        measurement('computed_sum', total, unit='count')\n        with TemporaryDirectory() as temporary:\n            evidence = Path(temporary) / 'calculation.txt'\n            evidence.write_text(f'sum={total}', encoding='utf-8')\n            attachment(evidence)\n    return {'passed': False, 'sum': total}\n";
    await call("create_workspace_file", { path, content });
    const saved = await call("read_workspace_file", { path });
    assert.equal(saved.content, content);
    const conflict = await client.callTool({ name: "write_workspace_file", arguments: { path, content: "must not overwrite", expectedHash: "stale" } });
    assert.equal(conflict.isError, true, "A stale write must fail");
    assert.equal(conflict.structuredContent.error.category, "conflict");
    assert.equal((await call("read_workspace_file", { path })).content, content);
    assert.deepEqual(await call("validate_python_file", { path }), []);
    const run = await call("start_python_run", { entrypoint: path, inputs: { values: [2, 3] }, hardwareIds: [] });
    const waited = await call("wait_for_status", { kind: "run", id: run.runId, timeoutMs: 1000 });
    assert.equal(waited.id, run.runId);
    assert.ok(waited.revision);
    let detail;
    const deadline = Date.now() + 30_000;
    do {
      detail = await call("get_python_run", { runId: run.runId });
      if (!["running", "cancelling"].includes(detail.run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(detail.run.status, "succeeded");
    assert.deepEqual(detail.run.result, { passed: false, sum: 5 });
    const events = [];
    let after = 0;
    while (true) {
      const page = await call("get_python_run_events", { runId: run.runId, after, limit: 10 });
      if (!page.length) break;
      events.push(...page);
      assert.ok(page.at(-1).sequence > after, "Event pagination must advance");
      after = page.at(-1).sequence;
    }
    assert.equal(new Set(events.map((event) => event.sequence)).size, events.length);
    assert.ok(events.some((event) => event.type === "measurement"));
    const summary = await call("get_python_run_summary", { runId: run.runId });
    assert.equal(summary.run.result.passed, false);
    const source = await call("read_python_run_source", { runId: run.runId, path });
    assert.equal(source.content, content);
    const evidence = summary.artifacts.find((artifact) => artifact.name === "calculation.txt");
    assert.ok(evidence, "Run attachments must have public artifact references");
    const chunks = [];
    let artifactOffset = 0;
    do {
      const page = await call("read_python_run_artifact", { runId: run.runId, artifactId: evidence.artifactId, offset: artifactOffset, limit: 2 });
      chunks.push(Buffer.from(page.contentBase64, "base64"));
      artifactOffset = page.nextOffset;
    } while (artifactOffset !== null);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "sum=5");
    return {
      status: "passed", publicTools: tools.length, publicOnly: true, hardwareInvoked: false,
      liveModelAssessed: false, independentCleanWindowsVerified: false,
      runtimeContext: context, runId: run.runId, runStatus: detail.run.status,
      businessPassed: detail.run.result.passed, events: events.length, referenceLines: lines.length,
      sourceSnapshotMatched: true, attachmentPages: chunks.length
    };
  } finally {
    await client.close();
  }
}
