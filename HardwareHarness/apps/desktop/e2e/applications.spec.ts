import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const desktopDir = resolve(import.meta.dirname, "..");

test("creates, edits and runs isolated Python programs from the scripts workspace", async () => {
  test.setTimeout(240_000);
  const userData = await mkdtemp(join(tmpdir(), "hardwareharness-scripts-"));
  const projectRoot = join(userData, "中文 项目");
  await mkdir(projectRoot);
  const env = {
    ...process.env,
    HARDWAREHARNESS_USER_DATA_DIR: userData,
    HARDWAREHARNESS_GATEWAY_PORT: "0",
    HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE: "1"
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [desktopDir], cwd: desktopDir, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await page.evaluate(async (root) => {
      await window.hardwareharness.projects.initializeFolder(root);
      await window.hardwareharness.projects.leave();
    }, projectRoot);
    await page.reload();
    await page.getByText("中文 项目", { exact: true }).first().click();
    await page.getByRole("tab", { name: "动作编排", exact: true }).click();
    await expect(page.getByRole("listbox", { name: "Python 脚本列表" })).toBeVisible();
    await expect(page.getByRole("button", { name: "准备 Python 环境", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "联网安装依赖", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "终端", exact: true })).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "新建脚本", exact: true }).click();
    const createDialog = page.getByRole("dialog", { name: "新建脚本", exact: true });
    await createDialog.getByLabel("脚本名称").fill("sample");
    await createDialog.getByLabel("脚本名称").press("Enter");
    await expect(createDialog).toBeHidden();
    await expect(page.getByRole("option", { name: "sample.py", exact: true })).toHaveAttribute("aria-selected", "true");
    const file = await page.evaluate(() =>
      window.hardwareharness.applications.readFile("scripts/sample.py")
    );
    expect(file.content).toBe("def main(inputs):\n    return {}\n");
    const source = "from hardwareharness import measurement, step\n\n" +
      "def main(inputs):\n" +
      "    print('脚本运行成功', flush=True)\n" +
      "    with step('sample'):\n" +
      "        measurement('value', 1, unit='count')\n" +
      "    return {'value': 1}\n";
    const editor = page.locator('.cm-content[contenteditable="true"]');
    await editor.fill(`${source}\n# Editor save verified\n`);
    await editor.press("Control+s");
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await window.hardwareharness.applications.readFile("scripts/sample.py")).content
        )
      )
      .toContain("# Editor save verified");
    await page.getByRole("button", { name: "新建脚本", exact: true }).click();
    await createDialog.getByLabel("脚本名称").fill("sample.py");
    await createDialog.getByRole("button", { name: "创建", exact: true }).click();
    await expect(createDialog.getByRole("alert")).toHaveText("同名脚本已存在，请换一个名称。");
    await createDialog.getByRole("button", { name: "取消", exact: true }).click();
    expect((await page.evaluate(() => window.hardwareharness.applications.readFile("scripts/sample.py"))).content).toContain("# Editor save verified");
    await page.getByRole("button", { name: "运行", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "终端", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect.poll(async () => {
      const runs = await page.evaluate(() => window.hardwareharness.applications.listRuns());
      return runs[0]?.status;
    }).toBe("succeeded");
    const record = (await page.evaluate(() => window.hardwareharness.applications.listRuns()))[0]!;
    expect(record.entrypoint).toBe("scripts/sample.py");
    const snapshot = await page.evaluate(async (id) => {
      const detail = await window.hardwareharness.applications.getRun(id);
      const step = detail.events.find((event) => event.type === "step.started");
      const source = step?.data.source as { path: string };
      return window.hardwareharness.applications.readRunSource(id, source.path);
    }, record.runId);
    expect(snapshot.content).toContain("from hardwareharness import");
    await expect(page.getByRole("log", { name: "脚本终端输出" })).toContainText("脚本运行成功");
    await expect(page.getByRole("log", { name: "脚本终端输出" })).toContainText("运行完成");
    const artifacts = resolve(desktopDir, "../../reports/applications/minimal-workspace");
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, "terminal-expanded.png") });
    await page.getByRole("button", { name: "终端", exact: true }).click();
    await expect(page.getByRole("log", { name: "脚本终端输出" })).toBeHidden();
    await page.screenshot({ path: join(artifacts, "terminal-collapsed.png") });
    await page.getByRole("button", { name: "终端", exact: true }).click();
    await expect(page.getByRole("log", { name: "脚本终端输出" })).toContainText("脚本运行成功");
    await expect(page.locator("iframe")).toHaveCount(0);
  } finally {
    await app.close();
    if (userData.startsWith(tmpdir())) await rm(userData, { recursive: true, force: true });
  }
});
