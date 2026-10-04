import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { rendererReady } from "./renderer.js";

const desktopDir = resolve(import.meta.dirname, "..");
const artifactPath = resolve(desktopDir, "../../output/playwright/welcome-reactflow-preview.png");
const gatewayPort = 18081;

test("renders the saved wiring canvas as a recent-project React Flow preview", async () => {
  const userDataDir = await mkdtemp(resolve(tmpdir(), "teststand-welcome-preview-"));
  const projectRoot = join(userDataDir, "project-preview");
  await mkdir(projectRoot);
  const env = { ...process.env, TESTSTAND_USER_DATA_DIR: userDataDir, TESTSTAND_GATEWAY_PORT: String(gatewayPort), TESTSTAND_AGENT_INTEGRATION_TEST_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [desktopDir], cwd: desktopDir, env, timeout: 90_000 });
  try {
    const page = await rendererReady(await application.firstWindow({ timeout: 90_000 }));
    await page.evaluate(async () => {
      await window.teststand.devices.saveHardware({ input: {
        formatVersion: 2,
        hardwareId: "DUT_A",
        label: "主控工位",
        kind: "passive",
        ports: [{ portId: "J1", name: "控制口", pins: [] }]
      } });
      await window.teststand.devices.saveHardware({ input: {
        formatVersion: 2,
        hardwareId: "DUT_B",
        label: "负载工位",
        kind: "passive",
        ports: [{ portId: "J1", name: "输入口", pins: [] }]
      } });
    });
    const file = await page.evaluate(async (rootPath) => {
      await window.teststand.projects.initializeFolder({ rootPath });
      const document = await window.teststand.wiring.updateDocument({ wiring: {
        nodes: [
          { hardwareId: "DUT_A", x: 10, y: 10, width: 260, height: 190, portPositions: { J1: { side: "right", offset: 0.35 } } },
          { hardwareId: "DUT_B", x: 360, y: 90, width: 170, height: 40, portPositions: { J1: { side: "left", offset: 0.65 } } }
        ],
        connections: [{
          connectionId: "preview-connection",
          portA: "DUT_A.J1",
          portB: "DUT_B.J1",
          pins: [],
          confirmedAt: new Date().toISOString(),
          confirmedBy: "e2e"
        }]
      } });
      await window.teststand.projects.leaveProject();
      return document.file;
    }, projectRoot);
    await writeFile(join(projectRoot, ".teststand", "project.json"), `${JSON.stringify(file, null, 2)}\n`, "utf8");
    // Wait for the leave notification to clear the renderer's dirty-project guard before reload.
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    // reload 可能触发 beforeunload(dirty guard);Playwright 对 Electron 的自动 dialog dismiss 存在竞态,显式接管
    page.on("dialog", (dialog) => void dialog.accept().catch(() => undefined));
    await page.reload({ waitUntil: "domcontentloaded" });
    await rendererReady(page);
    const preview = page.getByRole("img", { name: "project-preview 测试台架缩略图" });
    await expect(preview.locator(".react-flow__node")).toHaveCount(2);
    await expect(preview.locator(".react-flow__edge")).toHaveCount(1);
    const edgePath = preview.locator(".react-flow__edge.wiring-flow-edge .react-flow__edge-path");
    // Resolve the token as a color so Chromium normalizes percentages and decimal lightness alike.
    const edgeColor = await page.evaluate(() => {
      const sample = document.createElement("span");
      sample.style.color = "var(--tf-wiring-edge)";
      document.body.append(sample);
      const color = getComputedStyle(sample).color;
      sample.remove();
      return color;
    });
    await expect(edgePath).toHaveCSS("stroke", edgeColor);
    await expect(edgePath).toHaveCSS("stroke-width", "3.5px");
    await expect(preview.locator('[data-hardware-id="DUT_A"]')).toContainText("主控工位");
    await expect(preview.locator('[data-hardware-id="DUT_B"]')).toContainText("负载工位");
    await expect(preview.locator('.react-flow__node[data-id="DUT_A"]')).toHaveCSS("width", "260px");
    await expect(preview.locator('.react-flow__node[data-id="DUT_B"]')).toHaveCSS("height", "40px");
    await expect(preview.locator('[data-hardware-id="DUT_A"] .flow-connector[data-side="right"]')).toHaveCount(1);
    await expect(preview.locator('[data-hardware-id="DUT_B"] .flow-connector[data-side="left"]')).toHaveCount(1);
    await preview.screenshot({ path: artifactPath });
  } finally {
    await application.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true });
  }
});
