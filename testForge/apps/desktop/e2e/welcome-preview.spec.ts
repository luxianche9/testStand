import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const desktopDir = resolve(import.meta.dirname, "..");
const artifactPath = resolve(desktopDir, "../../output/playwright/welcome-reactflow-preview.png");
const gatewayPort = 18081;
const pixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQMcAAAAASUVORK5CYII=", "base64");

test("renders the saved wiring canvas as a recent-project React Flow preview", async () => {
  const userDataDir = await mkdtemp(resolve(tmpdir(), "testforge-welcome-preview-"));
  const projectRoot = join(userDataDir, "project-preview");
  await mkdir(projectRoot);
  const env = { ...process.env, TESTFORGE_USER_DATA_DIR: userDataDir, TESTFORGE_GATEWAY_PORT: String(gatewayPort), TESTFORGE_AGENT_INTEGRATION_TEST_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [desktopDir], cwd: desktopDir, env, timeout: 90_000 });
  try {
    const page = await application.firstWindow({ timeout: 90_000 });
    await page.evaluate(async () => {
      await window.testforge.devices.saveHardware({
        formatVersion: 2,
        hardwareId: "DUT_A",
        label: "主控工位",
        kind: "passive",
        ports: [{ portId: "J1", name: "控制口", pins: [] }],
        appearanceAssetId: "appearance.png"
      });
      await window.testforge.devices.saveHardware({
        formatVersion: 2,
        hardwareId: "DUT_B",
        label: "负载工位",
        kind: "passive",
        ports: [{ portId: "J1", name: "输入口", pins: [] }]
      });
    });
    await mkdir(join(userDataDir, "devices", "hardware", "DUT_A"), { recursive: true });
    await writeFile(join(userDataDir, "devices", "hardware", "DUT_A", "appearance.png"), pixelPng);
    const file = await page.evaluate(async (rootPath) => {
      await window.testforge.projects.initializeFolder(rootPath);
      const document = await window.testforge.wiring.update({
        nodes: [
          { hardwareId: "DUT_A", x: 10, y: 10, width: 260, height: 190, showImage: true, portPositions: { J1: { side: "right", offset: 0.35 } } },
          { hardwareId: "DUT_B", x: 360, y: 90, width: 170, height: 40, showImage: false, portPositions: { J1: { side: "left", offset: 0.65 } } }
        ],
        connections: [{
          connectionId: "preview-connection",
          portA: "DUT_A.J1",
          portB: "DUT_B.J1",
          pins: [],
          confirmedAt: new Date().toISOString(),
          confirmedBy: "e2e"
        }]
      });
      await window.testforge.projects.leave();
      return document.file;
    }, projectRoot);
    await writeFile(join(projectRoot, ".testforge", "project.json"), `${JSON.stringify(file, null, 2)}\n`, "utf8");
    // reload 可能触发 beforeunload(dirty guard);Playwright 对 Electron 的自动 dialog dismiss 存在竞态,显式接管
    page.on("dialog", (dialog) => void dialog.accept().catch(() => undefined));
    await page.reload({ waitUntil: "domcontentloaded" });
    const preview = page.getByRole("img", { name: "project-preview 工位接线缩略图" });
    await expect(preview.locator(".react-flow__node")).toHaveCount(2);
    await expect(preview.locator(".react-flow__edge")).toHaveCount(1);
    const edgePath = preview.locator(".react-flow__edge.wiring-flow-edge .react-flow__edge-path");
    // 接线边颜色来自设计 token --tf-wiring-edge;Chromium 对 SVG stroke 返回未解析的 oklch() 字符串,断言其等于 token 值而非具体 rgb
    await expect(edgePath).toHaveCSS("stroke", "oklch(0.52 0.16 255)");
    await expect(edgePath).toHaveCSS("stroke-width", "3.5px");
    await expect(preview.locator('[data-hardware-id="DUT_A"]')).toHaveAttribute("data-show-image", "true");
    await expect(preview.locator('[data-hardware-id="DUT_A"] img')).toHaveCount(1);
    await expect(preview.locator('[data-hardware-id="DUT_A"]')).toContainText("主控工位");
    await expect(preview.locator('[data-hardware-id="DUT_B"]')).toHaveAttribute("data-show-image", "false");
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
