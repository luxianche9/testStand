import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { reloadAfterLeave, rendererReady } from "./renderer.js";

const desktopDir = resolve(import.meta.dirname, "..");
const workspaceDir = resolve(desktopDir, "../..");
const artifactDir = resolve(workspaceDir, "output/playwright");
const gatewayPort = 18080;
const gatewayTestToken = "teststand-e2e-gateway-token";

let application: ElectronApplication;
let page: Page;
let userDataDir: string;
let projectRoot: string;
const rendererErrors: string[] = [];

test.describe.serial("testStand folder project desktop", () => {
  test.beforeAll(async () => {
    await mkdir(artifactDir, { recursive: true });
    userDataDir = await mkdtemp(resolve(tmpdir(), "teststand-e2e-"));
    projectRoot = join(userDataDir, "project-a");
    await mkdir(projectRoot);
    const env = {
      ...process.env,
      TESTSTAND_USER_DATA_DIR: userDataDir,
      TESTSTAND_GATEWAY_PORT: String(gatewayPort),
      TESTSTAND_AGENT_INTEGRATION_TEST_MODE: "1",
      TESTSTAND_GATEWAY_TEST_TOKEN: gatewayTestToken
    };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ args: [desktopDir], cwd: desktopDir, env, timeout: 90_000 });
    page = await rendererReady(await application.firstWindow({ timeout: 90_000 }));
    page.setDefaultTimeout(60_000);
    page.on("pageerror", (error) => rendererErrors.push(error.stack ?? error.message));
    page.on("console", (message) => { if (message.type() === "error") rendererErrors.push(message.text()); });
  });

  test.afterAll(async () => {
    if (application) {
      const process = application.process();
      await Promise.race([application.close().catch(() => undefined), new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000))]);
      if (process && !process.killed) {
        try { process.kill(); } catch { /* already exited */ }
        if (process.pid) await promisify(execFile)("taskkill", ["/PID", String(process.pid), "/T", "/F"]).catch(() => undefined);
      }
    }
    if (userDataDir?.startsWith(tmpdir())) await rm(userDataDir, { recursive: true, force: true });
  });

  test("starts on the welcome page and gates project-only navigation", async () => {
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开项目文件夹" })).toBeVisible();
    await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "测试台架", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开 AI 侧栏" })).toHaveCount(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "外观" })).toBeVisible();
    await expect(page.getByRole("button", { name: "测试台架", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await page.screenshot({ path: resolve(artifactDir, "welcome-light.png"), fullPage: true });
    expect(await page.evaluate(() => typeof window.teststand)).toBe("object");
    expect(rendererErrors).toEqual([]);
  });

  test("initializes a folder project and exposes the full top navigation", async () => {
    const document = await page.evaluate((rootPath) => window.teststand.projects.initializeFolder({ rootPath }), projectRoot);
    expect(document.path.replaceAll("\\", "/")).toMatch(/\/\.teststand\/project\.json$/);
    await page.evaluate(() => window.teststand.projects.leaveProject());
    await reloadAfterLeave(page);
    // Every launch still returns to the welcome page even when recent projects exist.
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await page.getByText("project-a", { exact: true }).first().click();
    await expect(page.getByRole("tab", { name: "测试台架", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "测试编排", exact: true })).toBeVisible();
    // Runs are watched on the bench's signal view; there is no separate monitor page.
    await expect(page.getByRole("tab", { name: "运行监控", exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "设备管理", exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "工位接线", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开 AI 侧栏" })).toBeVisible();
  });

  test("registers hardware and keeps wiring intact", async () => {
    const result = await page.evaluate(async () => {
      for (const hardwareId of ["DUT_A", "DUT_B"]) {
        await window.teststand.devices.saveHardware({ input: {
          formatVersion: 2, hardwareId, label: hardwareId, kind: "passive",
          ports: [
            { portId: "J1", name: "J1", pins: [{ pinId: "1", position: 1, label: "A" }, { pinId: "2", position: 2, label: "B" }] },
            { portId: "FIBER", name: "光纤口", pins: [] }
          ]
        } });
      }
      const pending = await window.teststand.wiring.requestTask({ input: { portA: "DUT_A.J1", portB: "DUT_B.J1", pins: [{ a: "1", b: "1" }, { a: "2", b: "2" }], action: "connect" } });
      await window.teststand.wiring.startTask({ taskId: pending.wiringTaskId, operatorName: "e2e" });
      await window.teststand.wiring.completeTask({ taskId: pending.wiringTaskId, outcome: "confirmed" });
      const beforeSave = await window.teststand.projects.document();
      const afterSave = await window.teststand.projects.saveProject();
      return { beforeSave, afterSave };
    });
    expect(result.beforeSave?.dirty).toBe(true);
    expect(result.afterSave.dirty).toBe(false);
    expect(result.beforeSave?.file.wiring.connections[0]?.pins).toEqual([{ a: "1", b: "1" }, { a: "2", b: "2" }]);

    await page.getByRole("tab", { name: "测试台架", exact: true }).click();
    const list = page.getByRole("tabpanel", { name: "设备列表" });
    await list.getByRole("button", { name: /DUT_A/ }).click();
    await expect(page.getByRole("dialog", { name: "DUT_A" }).getByText("光纤口")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: resolve(artifactDir, "bench-page.png"), fullPage: true });
    await page.getByRole("tab", { name: /^接线日志/ }).click();
    await expect(page.getByRole("tabpanel", { name: "接线日志" }).getByRole("region", { name: "历史记录" })).toBeVisible();
    await expect(page.getByRole("button", { name: "信箱" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "命令面板" })).toHaveCount(0);
    await page.screenshot({ path: resolve(artifactDir, "project-wiring.png") });

  });

  test("processes consecutive Agent wiring requests through clickable confirmations", async () => {
    const taskIds = await page.evaluate(async () => {
      const connect = await window.teststand.wiring.requestTask({ input: {
        portA: "DUT_A.FIBER",
        portB: "DUT_B.FIBER",
        action: "connect"
      } });
      const disconnect = await window.teststand.wiring.requestTask({ input: {
        portA: "DUT_A.J1",
        portB: "DUT_B.J1",
        pins: [{ a: "1", b: "1" }, { a: "2", b: "2" }],
        action: "disconnect"
      } });
      return [connect.wiringTaskId, disconnect.wiringTaskId];
    });

    await expect(page.getByLabel("2 条待处理接线任务")).toBeVisible();
    await page.getByRole("tab", { name: "测试台架", exact: true }).click();
    await page.getByRole("tab", { name: /^接线日志/ }).click();
    const pending = page.getByRole("tabpanel", { name: "接线日志" }).getByRole("region", { name: "待处理" });
    for (let remaining = taskIds.length; remaining > 0; remaining--) {
      const cards = pending.getByRole("region", { name: /^(接线|断线)任务$/ });
      await expect(cards).toHaveCount(remaining);
      const confirm = cards.first().getByRole("button", { name: "完成", exact: true });
      await expect(confirm).toBeEnabled();
      await confirm.click();
    }

    await expect(pending).toHaveCount(0);
    const completed = await page.evaluate(async (ids) => Promise.all(ids.map((id) => window.teststand.wiring.getTask({ taskId: id }))), taskIds);
    expect(completed.map((task) => task.status)).toEqual(["confirmed", "confirmed"]);
  });

  test("uses settings as the only configuration surface and switches themes", async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "外观" })).toBeVisible();
    await page.getByRole("button", { name: "深色 始终使用深色界面。" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: resolve(artifactDir, "settings-dark.png"), fullPage: true });

    await page.getByRole("button", { name: "AI 模型" }).click();
    await expect(page.getByLabel("Base URL")).toBeVisible();
    await expect(page.getByLabel("模型 ID")).toBeVisible();
    await expect(page.getByText("OpenCode", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Agent 接入" }).click();
    await expect(page.getByText("MCP Gateway", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Codex", { exact: true }).first()).toBeVisible();

    await page.getByRole("tab", { name: "测试台架", exact: true }).click();
    const openAssistant = page.getByRole("button", { name: "打开 AI 侧栏" });
    if (await openAssistant.isVisible()) await openAssistant.click();
    await expect(page.getByRole("button", { name: "关闭 AI 侧栏" })).toBeVisible();
    const sidebar = page.locator(".tf-agent-sidebar");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "打开模型设置" })).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: "启动助手" })).toHaveCount(0);
    await expect(sidebar.getByLabel(/OpenCode 状态/)).toBeVisible();
    await page.screenshot({ path: resolve(artifactDir, "assistant-sidebar-dark.png") });
  });

  test("lets the Agent MCP create, edit, validate and control a test plan", async () => {
    const client = await connectGateway();
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "create_test_plan", "apply_test_plan_operations", "validate_test_plan",
        "start_test_run", "pause_test_run", "resume_test_run", "abort_test_run",
        "wait_for_test_run", "read_test_run_results"
      ]));
      const created = mcpData(await client.callTool({
        name: "create_test_plan",
        arguments: { requestId: "e2e-create-plan", id: "agent-e2e", name: "Agent 编排计划" }
      }));
      expect(created.plan.revision).toBe(1);
      const added = mcpData(await client.callTool({
        name: "apply_test_plan_operations",
        arguments: {
          planId: "agent-e2e", baseRevision: 1, requestId: "e2e-add-steps",
          operations: [
            { type: "insert_step", region: "test", step: { id: "sequence", type: "Sequence", name: "测试序列", children: [] } },
            { type: "insert_step", region: "test", step: { id: "delay", type: "Delay", name: "等待终止", durationMs: 10_000 } },
            { type: "insert_step", region: "cleanup", step: { id: "cleanup_result", type: "PublishResult", name: "安全清理", value: "done" } }
          ]
        }
      }));
      expect(added.appliedOperations).toBe(3);
      const moved = mcpData(await client.callTool({
        name: "apply_test_plan_operations",
        arguments: {
          planId: "agent-e2e", baseRevision: 2, requestId: "e2e-move-step",
          operations: [{ type: "move_step", stepId: "delay", region: "test", parentId: "sequence", index: 0 }]
        }
      }));
      expect(moved.plan.revision).toBe(3);
      const validation = mcpData(await client.callTool({ name: "validate_test_plan", arguments: { planId: "agent-e2e" } }));
      expect(validation).toMatchObject({ valid: true, revision: 3 });
      const started = mcpData(await client.callTool({
        name: "start_test_run",
        arguments: {
          planId: "agent-e2e", revision: 3, executionRevision: validation.executionRevision,
          requestId: "e2e-start-run", parameters: {}
        }
      }));
      const duplicate = mcpData(await client.callTool({
        name: "start_test_run",
        arguments: {
          planId: "agent-e2e", revision: 3, executionRevision: validation.executionRevision,
          requestId: "e2e-start-run", parameters: {}
        }
      }));
      expect(duplicate.runId).toBe(started.runId);
      await client.callTool({ name: "pause_test_run", arguments: { runId: started.runId } });
      let sequence = 0;
      let snapshot = started;
      for (let attempt = 0; attempt < 5 && snapshot.state !== "paused"; attempt += 1) {
        const waited = mcpData(await client.callTool({ name: "wait_for_test_run", arguments: { runId: started.runId, afterSequence: sequence, timeoutMs: 5_000 } }));
        snapshot = waited.run;
        sequence = snapshot.sequence;
      }
      expect(snapshot.state).toBe("paused");
      await client.callTool({ name: "resume_test_run", arguments: { runId: started.runId } });
      await client.callTool({ name: "abort_test_run", arguments: { runId: started.runId } });
      for (let attempt = 0; attempt < 5 && !["completed", "aborted", "error"].includes(snapshot.state); attempt += 1) {
        const waited = mcpData(await client.callTool({ name: "wait_for_test_run", arguments: { runId: started.runId, afterSequence: sequence, timeoutMs: 5_000 } }));
        snapshot = waited.run;
        sequence = snapshot.sequence;
      }
      expect(snapshot).toMatchObject({ state: "aborted", verdict: "Aborted" });
      const results = mcpData(await client.callTool({ name: "read_test_run_results", arguments: { runId: started.runId, afterSequence: 0 } }));
      expect(results.results).toEqual(expect.arrayContaining([expect.objectContaining({ name: "安全清理", value: "done" })]));

      await page.getByRole("tab", { name: "测试编排", exact: true }).click();
      await expect(page.getByRole("list", { name: "功能测试项" }).getByText("Agent 编排计划", { exact: true }).first())
        .toBeVisible();
      await expect(page.getByRole("list", { name: "功能测试项" }).getByText("中止", { exact: true }).first()).toBeVisible();
    } finally {
      await client.close();
    }
  });

  test("protects dirty project transitions with save, discard, and cancel", async () => {
    await page.evaluate(async () => {
      const current = await window.teststand.projects.document();
      if (!current) throw new Error("project missing");
      const signals = current.file.signals;
      await window.teststand.signals.updateDocument({ signals: { ...signals, nodes: [...signals.nodes,
        { nodeId: "extra", kind: "widget", widget: "value", label: "", config: {}, x: 300, y: 20 }] } });
    });
    await requestLeaveProject(page);
    const dialog = page.getByRole("dialog", { name: "保存项目修改" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "保存并继续" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "放弃修改" })).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("tab", { name: "测试台架", exact: true })).toBeVisible();
    await requestLeaveProject(page);
    await dialog.getByRole("button", { name: "放弃修改" }).click();
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开 AI 侧栏" })).toHaveCount(0);
  });

  test("exposes gateway tools and rejects project tools while no project is active", async () => {
    const client = new Client({ name: "e2e", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${gatewayTestToken}` } } });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("request_wiring_task");
    expect(names).not.toContain("list_test_flows");
    expect(names).not.toContain("start_python_run");
    const task = await client.callTool({ name: "request_wiring_task", arguments: { portA: "A.J1", portB: "B.J1", action: "connect" } });
    expect(task.isError).toBeTruthy();
    await client.close();
    expect(rendererErrors).toEqual([]);
  });
});

async function requestLeaveProject(page: Page): Promise<void> {
  await page.getByRole("button", { name: "项目文件夹菜单" }).click();
  await page.getByRole("menuitem", { name: "退出", exact: true }).click();
}

async function connectGateway(): Promise<Client> {
  const client = new Client({ name: "e2e", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${gatewayTestToken}` } } });
  await client.connect(transport);
  return client;
}

function mcpData(result: { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }): any {
  let value = result.structuredContent;
  if (!value) {
    const text = result.content?.find((item) => item.type === "text")?.text;
    value = text ? JSON.parse(text) : {};
  }
  while (value && typeof value === "object" && !Array.isArray(value) && "data" in value) value = (value as { data: unknown }).data;
  return value;
}
