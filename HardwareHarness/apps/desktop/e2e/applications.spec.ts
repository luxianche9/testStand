import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const desktopDir = resolve(import.meta.dirname, "..");

test("runs isolated embedded FastAPI operations and inspects Python snapshots", async () => {
  test.setTimeout(240_000);
  const userData = await mkdtemp(join(tmpdir(), "hardwareharness-applications-"));
  const projectRoot = join(userData, "中文 项目");
  await mkdir(projectRoot);
  const env = { ...process.env, HARDWAREHARNESS_USER_DATA_DIR: userData, HARDWAREHARNESS_GATEWAY_PORT: "0", HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [desktopDir], cwd: desktopDir, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await page.evaluate(async (root) => {
      await window.hardwareharness.projects.initializeFolder(root);
      await window.hardwareharness.applications.createApp("sample", "Sample");
      await window.hardwareharness.applications.initializeWorkspace();
      await window.hardwareharness.projects.leave();
    }, projectRoot);
    await page.reload();
    await page.getByText("中文 项目", { exact: true }).first().click();
    await page.getByRole("tab", { name: "应用搭建", exact: true }).click();
    await page.getByRole("treeitem", { name: "sample.py", exact: true }).click();
    const file = await page.evaluate(() => window.hardwareharness.applications.readFile("workflows/sample.py"));
    const editor = page.locator('.cm-content[contenteditable="true"]');
    await editor.fill(file.content + "\n# Editor save verified\n");
    await editor.press("Control+s");
    await expect.poll(() => page.evaluate(async () => (await window.hardwareharness.applications.readFile("workflows/sample.py")).content)).toContain("# Editor save verified");
    await page.getByLabel("选择应用").selectOption("sample");
    await page.getByRole("button", { name: "启动应用", exact: true }).click();
    const preview = page.frameLocator('iframe[title="应用 Web 预览"]');
    await expect(preview.getByRole("heading", { name: "HardwareHarness 应用" })).toBeVisible().catch(async (error: unknown) => {
      await test.info().attach("preview-diagnostics", { contentType: "application/json", body: JSON.stringify(await Promise.all(page.frames().slice(1).map(async (frame) => ({ url: frame.url().split("?")[0], text: await frame.locator("body").innerText().catch(() => "unavailable") })))) });
      throw error;
    });
    const authority = await preview.locator("body").evaluate(() => ({ bridge: typeof (window as unknown as { hardwareharness?: unknown }).hardwareharness, require: typeof (window as unknown as { require?: unknown }).require }));
    expect(authority).toEqual({ bridge: "undefined", require: "undefined" });
    for (let index = 0; index < 2; index++) {
      await preview.getByLabel("采样次数").fill("1");
      await preview.getByRole("button", { name: "运行", exact: true }).click();
      await expect(preview.getByRole("status")).toHaveText("succeeded");
      await expect(preview.getByLabel("运行日志")).toContainText("measurement");
    }
    const records = await page.evaluate(() => window.hardwareharness.applications.listRuns());
    expect(records).toHaveLength(2);
    expect(new Set(records.map((run) => run.runId)).size).toBe(2);
    expect(records.every((run) => run.applicationId === "sample" && run.status === "succeeded")).toBe(true);
    const snapshot = await page.evaluate(async (id) => {
      const detail = await window.hardwareharness.applications.getRun(id);
      const step = detail.events.find((event) => event.type === "step.started");
      const source = step?.data.source as { path: string };
      return window.hardwareharness.applications.readRunSource(id, source.path);
    }, records[0]!.runId);
    expect(snapshot.content).toContain("from hardwareharness import");
    await page.screenshot({ path: resolve(desktopDir, "../../reports/applications/embedded-preview.png") });
    await page.getByRole("button", { name: "停止应用", exact: true }).click();
    await expect(page.locator('iframe[title="应用 Web 预览"]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () => (await window.hardwareharness.applications.listApps())[0]?.status)).toBe("stopped");
  } finally {
    await app.close();
    if (userData.startsWith(tmpdir())) await rm(userData, { recursive: true, force: true });
  }
});
