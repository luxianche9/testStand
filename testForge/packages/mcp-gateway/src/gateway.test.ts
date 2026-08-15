import http from "node:http";
import Ajv from "ajv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testTaskSchema, type TestStep } from "@testforge/contracts/orchestration";
import { TestForgeApplication } from "@testforge/application";
import { LocalMcpGateway } from "./gateway.js";
import { UPDATE_TEST_TASK_INPUT_SCHEMA } from "./tools/index.js";

function request(port: number, headers: Record<string, string> = {}, body = "{}"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function protocolRequest(port: number, method: "GET" | "POST" | "DELETE", headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/mcp", method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function makeApplication(overrides: { devices?: Record<string, unknown>; wiring?: Record<string, unknown>; orchestration?: Record<string, unknown> } = {}) {
  const devices = {
    store: { putImageBytes: vi.fn(async () => ({})), putImage: vi.fn(async () => ({})), removeImage: vi.fn(async () => ({})), exportBundle: vi.fn(), importBundle: vi.fn() },
    pool: { findTool: vi.fn(() => ({ tool: { kind: "hardware" } })) },
    listComputers: vi.fn(() => []), listStatuses: vi.fn(() => []), listServers: vi.fn(() => []), listServerStatuses: vi.fn(() => []),
    listHardware: vi.fn(() => []), listAvailability: vi.fn(() => []), listTools: vi.fn(() => []),
    saveComputer: vi.fn(async (value: unknown) => value), removeComputer: vi.fn(), refreshComputer: vi.fn(async () => ({})),
    refreshServer: vi.fn(async () => ({})), refreshAllServers: vi.fn(async () => []), saveServer: vi.fn(async (value: unknown) => value), removeServer: vi.fn(),
    execute: vi.fn(async () => ({})), serverAction: vi.fn(async () => ({})), readServerLogs: vi.fn(async () => ({ lines: [], truncated: false })),
    refreshHardware: vi.fn(async () => []), callAggregatedTool: vi.fn(async () => "ok"),
    ...overrides.devices
  };
  const catalog = {
    listHardware: vi.fn(() => []), getHardware: vi.fn((hardwareId: string) => ({ hardwareId, kind: "managed", ports: [] })),
    saveHardware: vi.fn(async (value: unknown) => value), removeHardware: vi.fn()
  };
  const projects = {
    document: vi.fn(() => ({ dirty: false, file: { task: {} } })), updateWiring: vi.fn(), save: vi.fn(), close: vi.fn()
  };
  const wiring = {
    addManagedHardwareToCanvas: vi.fn(async () => ({ added: true })), requestTask: vi.fn(async () => ({ wiringTaskId: "WT" })),
    cancelTask: vi.fn(async () => ({ wiringTaskId: "WT", status: "cancelled" })), getTask: vi.fn(() => ({ wiringTaskId: "WT" })), listTasks: vi.fn(() => []),
    startTask: vi.fn(), completeTask: vi.fn(), close: vi.fn(), clearSession: vi.fn(), initialize: vi.fn(), ...overrides.wiring
  };
  const orchestration = {
    getTask: vi.fn(() => ({ taskId: "TASK" })), updateTask: vi.fn((task: unknown) => ({ dirty: true, file: { task } })),
    validateTask: vi.fn(() => ({ valid: true, issues: [] })), startRun: vi.fn(async () => ({ run: { runId: "RUN" }, nodeRuns: [], events: [] })),
    cancelRun: vi.fn(async () => ({ runId: "RUN" })), getRun: vi.fn(() => ({ run: { runId: "RUN" }, nodeRuns: [], events: [] })),
    listOperatorDecisions: vi.fn(() => []), respondOperatorDecision: vi.fn(), close: vi.fn(), clearSession: vi.fn(), initialize: vi.fn(), ...overrides.orchestration
  };
  const application = new TestForgeApplication({
    devices: devices as never, catalog: catalog as never, projects: projects as never, wiring: wiring as never, orchestration: orchestration as never,
    system: { gatewayStatus: () => ({ running: false, endpoint: "http://127.0.0.1:8000/mcp", tokenConfigured: true, toolCount: 0 }) }
  });
  return { application, devices, catalog, wiring, orchestration };
}

function secretStore(initial = "test-token") {
  let token = initial;
  return {
    ensureToken: vi.fn(async () => token),
    set: vi.fn(async (_ref: string, value: { token: string }) => { token = value.token; })
  };
}

describe("LocalMcpGateway transport", () => {
  let gateway: LocalMcpGateway | undefined;
  afterEach(async () => { await gateway?.stop(); gateway = undefined; });

  it("binds loopback and requires its bearer token", async () => {
    const port = 18001;
    gateway = new LocalMcpGateway(makeApplication().application, secretStore() as never, port);
    await gateway.start();
    expect(gateway.status()).toMatchObject({ running: true, endpoint: `http://127.0.0.1:${port}/mcp` });
    expect(await request(port)).toBe(401);
  });

  it("rejects untrusted Host and Origin before protocol handling", async () => {
    const port = 18002;
    gateway = new LocalMcpGateway(makeApplication().application, secretStore() as never, port);
    await gateway.start();
    expect(await request(port, { host: `192.168.3.50:${port}`, authorization: "Bearer test-token" })).toBe(403);
    expect(await request(port, { origin: "http://192.168.3.50", authorization: "Bearer test-token" })).toBe(403);
  });

  it("applies a durably rotated token immediately", async () => {
    const port = 18003;
    const secrets = secretStore("old-token");
    gateway = new LocalMcpGateway(makeApplication().application, secrets as never, port);
    await gateway.start();
    const token = await gateway.rotateToken();
    expect(secrets.set).toHaveBeenCalled();
    expect(await request(port, { authorization: "Bearer old-token" })).toBe(401);
    expect(await request(port, { authorization: `Bearer ${token}` })).not.toBe(401);
  });

  it("rejects request bodies larger than one MiB", async () => {
    const port = 18005;
    gateway = new LocalMcpGateway(makeApplication().application, secretStore() as never, port);
    await gateway.start();

    const oversized = JSON.stringify({ value: "x".repeat(1_048_576) });
    expect(await request(port, {
      authorization: "Bearer test-token",
      "content-type": "application/json"
    }, oversized)).toBe(413);
  });

  it("falls back to an ephemeral port when the preferred port is occupied", async () => {
    const occupied = http.createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    try {
      gateway = new LocalMcpGateway(makeApplication().application, secretStore() as never, address.port);
      await gateway.start();

      const status = gateway.status();
      expect(status.running).toBe(true);
      expect(new URL(status.endpoint).port).not.toBe(String(address.port));
      expect(status.lastError).toMatch(/port was occupied/i);
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("maintains a stateful session and exposes only authorized Agent tools", async () => {
    const port = 18004;
    const fixture = makeApplication();
    const authorize = vi.spyOn(fixture.application.authorizer, "authorize");
    gateway = new LocalMcpGateway(fixture.application, secretStore() as never, port);
    await gateway.start();
    const headers = { authorization: "Bearer test-token", accept: "application/json, text/event-stream", "content-type": "application/json" };
    const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex", version: "1.0" } } });
    const initialized = await protocolRequest(port, "POST", headers, initialize);
    const sessionId = String(initialized.headers["mcp-session-id"] ?? "");
    expect(initialized.status).toBe(200);
    expect(sessionId).not.toBe("");
    const sessionHeaders = { ...headers, "mcp-session-id": sessionId };
    await protocolRequest(port, "POST", sessionHeaders, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const tools = await protocolRequest(port, "POST", sessionHeaders, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
    expect(tools.body).toContain("request_wiring_task");
    expect(tools.body).toContain("start_test_run");
    expect(tools.body).toContain("save_hardware_definition");
    expect(tools.body).not.toContain("save_remote_computer");
    expect(tools.body).not.toContain("register_mcp_server");
    expect(tools.body).not.toContain("ssh_execute");
    expect(tools.body).not.toContain("force_stop_remote_mcp_service");
    expect(gateway.status().lastClient).toMatchObject({ name: "codex", version: "1.0" });
    await protocolRequest(port, "POST", sessionHeaders, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_test_task", arguments: {} } }));
    const sessionContext = authorize.mock.calls.find(([, capability]) => capability === "orchestration.read")?.[0];
    expect(sessionContext).toMatchObject({ actor: "agent", source: "mcp", subjectId: "codex@1.0", requestId: expect.any(String) });
    expect((await protocolRequest(port, "DELETE", sessionHeaders)).status).toBe(200);
  });
});

describe("MCP tool registry", () => {
  it("omits permanently unsupported privileged tools", async () => {
    const gateway = new LocalMcpGateway(makeApplication().application, secretStore() as never);
    const names = gateway.listBuiltinTools().map((tool) => tool.name);
    expect(names).not.toContain("save_remote_computer");
    expect(names).not.toContain("register_mcp_server");
    expect(names).not.toContain("ssh_execute");
    expect(names).not.toContain("force_stop_remote_mcp_service");
    await expect(gateway.invokeTool("save_remote_computer", {})).rejects.toMatchObject({ category: "not_found" });
    await expect(gateway.invokeTool("ssh_execute", {})).rejects.toMatchObject({ category: "not_found" });
  });

  it("routes allowed wiring, orchestration and aggregated hardware calls", async () => {
    const remoteTool = { externalName: "S1.measure", remoteName: "measure", serverId: "S1", inputSchema: { type: "object" }, kind: "hardware" };
    const fixture = makeApplication({ devices: { listTools: vi.fn(() => [remoteTool]) } });
    const gateway = new LocalMcpGateway(fixture.application, secretStore() as never);
    await gateway.invokeTool("request_wiring_task", { portA: "A.J1", portB: "B.J1", action: "connect" });
    await gateway.invokeTool("start_test_run", {});
    await gateway.invokeTool("S1.measure", { voltage: 5 });
    expect(fixture.wiring.requestTask).toHaveBeenCalledWith(expect.objectContaining({ requestedBy: "agent" }));
    expect(fixture.orchestration.startRun).toHaveBeenCalledWith({ inputs: {} });
    expect(fixture.devices.callAggregatedTool).toHaveBeenCalledWith("S1.measure", { voltage: 5 });
  });

  it("has unique names and valid object schemas, including aggregated tools", () => {
    const remoteTool = { externalName: "S1.measure", remoteName: "measure", serverId: "S1", inputSchema: { type: "object", properties: {} }, kind: "hardware" };
    const gateway = new LocalMcpGateway(makeApplication({ devices: { listTools: () => [remoteTool] } }).application, secretStore() as never);
    const tools = gateway.listTools();
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
  });

  it("rejects a remote tool name that collides with a builtin", () => {
    const duplicate = { externalName: "get_test_task", remoteName: "duplicate", serverId: "S1", inputSchema: { type: "object" }, kind: "hardware" };
    const gateway = new LocalMcpGateway(makeApplication({ devices: { listTools: () => [duplicate] } }).application, secretStore() as never);
    expect(() => gateway.listTools()).toThrow(/Duplicate MCP tool name/);
  });

  it("keeps all recursive workflow variants bidirectionally consistent", () => {
    const steps: TestStep[] = [
      { stepId: "tool", label: "Tool", enabled: true, type: "tool", toolName: "S1.measure", hardwareId: "HW1", arguments: { voltage: { kind: "literal", value: 5 } }, outputBindings: [{ variable: "result", pointer: "" }], timeoutMs: 1_000, idempotent: false, retry: { maxAttempts: 1, delayMs: 0, backoff: "fixed", retryOn: ["unavailable"] } },
      { stepId: "delay", label: "Delay", enabled: true, type: "delay", durationMs: { kind: "literal", value: 1 } },
      { stepId: "set", label: "Set", enabled: true, type: "set_variable", variable: "result", value: { kind: "literal", value: 1 } },
      { stepId: "assert", label: "Assert", enabled: true, type: "assert", expression: { kind: "literal", value: true }, message: "failed" },
      { stepId: "if", label: "If", enabled: true, type: "if", condition: { kind: "literal", value: true }, then: [], else: [] },
      { stepId: "loop", label: "Loop", enabled: true, type: "loop", mode: "count", count: { kind: "literal", value: 2 }, maxIterations: 10, indexVariable: "i", body: [] },
      { stepId: "parallel", label: "Parallel", enabled: true, type: "parallel", branches: [{ branchId: "a", name: "A", steps: [] }, { branchId: "b", name: "B", steps: [] }] },
      { stepId: "operator", label: "Operator", enabled: true, type: "operator", prompt: "Continue?", options: [{ label: "Yes", value: "yes" }], resultVariable: "result" }
    ];
    const validate = new Ajv({ strict: false }).compile(UPDATE_TEST_TASK_INPUT_SCHEMA);
    for (const step of steps) {
      const fixture = { formatVersion: 2 as const, taskId: `TASK-${step.type}`, name: "Fixture", inputs: [], variables: [], setup: [], steps: [step], cleanup: [] };
      expect(testTaskSchema.safeParse(structuredClone(fixture)).success, step.type).toBe(true);
      expect(validate({ task: structuredClone(fixture) }), step.type).toBe(true);
      const parsed = testTaskSchema.parse(fixture);
      expect(validate({ task: structuredClone(parsed) }), `${step.type} from zod`).toBe(true);

      const invalidStep = { ...structuredClone(step), unexpected: true };
      const invalid = { ...fixture, steps: [invalidStep] };
      expect(testTaskSchema.safeParse(invalid).success, `${step.type} zod rejects extras`).toBe(false);
      expect(validate({ task: invalid }), `${step.type} json schema rejects extras`).toBe(false);
    }
  });
});
