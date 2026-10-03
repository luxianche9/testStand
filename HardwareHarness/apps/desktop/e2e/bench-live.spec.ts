// Real-bench walkthrough (temporary). Runs only with HARDWAREHARNESS_BENCH=1 against the deployed MCP services.
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { rendererReady } from "./renderer.js";

const desktopDir = resolve(import.meta.dirname, "..");
const outDir = resolve(desktopDir, "../../output/bench");
const profile = join(process.env.APPDATA ?? "", "HardwareHarness");
const CARDS = {
  ai: "PC1_MCP.PCI1710L_CARD_0",
  relay: "PC1_MCP.PCI1762_CARD_0",
  ao: "PC1_MCP.PCI6208V_CARD_0",
  serial: "PC1_MCP.CP118U_I_CARD_0"
};
const SERVERS = ["PCI1710L_MCP", "PCI1762_MCP", "PCI6208V_MCP", "CP118U_I_MCP"];

test.skip(process.env.HARDWAREHARNESS_BENCH !== "1", "bench only");
test.describe.configure({ mode: "serial", timeout: 300_000 });

let application: ElectronApplication;
let page: Page;
let userDataDir: string;
let projectRoot: string;

async function dump(name: string, value: unknown) {
  await writeFile(join(outDir, `${name}.json`), JSON.stringify(value, null, 2));
}

test.beforeAll(async () => {
  await mkdir(outDir, { recursive: true });
  userDataDir = await mkdtemp(resolve(tmpdir(), "hardwareharness-bench-"));
  for (const item of ["devices", "secrets.json", "settings.json", "Local State"]) {
    await cp(join(profile, item), join(userDataDir, item), { recursive: true });
  }
  projectRoot = join(userDataDir, "bench-project");
  await mkdir(projectRoot);
  const env = {
    ...process.env,
    HARDWAREHARNESS_USER_DATA_DIR: userDataDir,
    HARDWAREHARNESS_GATEWAY_PORT: "18093",
    HARDWAREHARNESS_GATEWAY_TEST_TOKEN: "bench-token",
    HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE: "1"
  };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [desktopDir], cwd: desktopDir, env, timeout: 90_000 });
  const appLog = createWriteStream(join(outDir, "app.log"));
  application.process().stdout?.pipe(appLog);
  application.process().stderr?.pipe(appLog);
  application.process().once("exit", (code, signal) => appLog.write(`
[exit] code=${code} signal=${signal}
`));
  page = await rendererReady(await application.firstWindow({ timeout: 90_000 }));
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
});

test.afterAll(async () => {
  await application?.close().catch(() => undefined);
  if (userDataDir?.startsWith(tmpdir())) await rm(userDataDir, { recursive: true, force: true });
});

test("project, servers and live streams", async () => {
  const setup = await page.evaluate(async ({ projectRoot, cards, servers }) => {
    const api = window.hardwareharness;
    await api.projects.initializeFolder(projectRoot);
    const ids = Object.values(cards);
    await api.wiring.update({
      nodes: ids.map((hardwareId, index) => ({ hardwareId, x: 40 + index * 320, y: 40, portPositions: {} })),
      connections: []
    });
    await api.projects.save();
    const status: Record<string, unknown> = {};
    for (const serverId of servers) status[serverId] = await api.devices.refreshServer(serverId);
    const streams: Record<string, unknown> = {};
    const tools: Record<string, unknown> = {};
    for (const id of ids) {
      streams[id] = await api.streams.listStreams(id);
      tools[id] = (await api.testing.listDeviceTools(id)).tools.map((tool) => ({
        name: tool.toolName, kind: tool.operationSemantics.kind, bindingRevision: tool.bindingRevision,
        input: tool.inputSchema
      }));
    }
    return { status, streams, tools };
  }, { projectRoot, cards: CARDS, servers: SERVERS });
  await dump("1-setup", setup);

  // Manual loopback checks while one live subscription watches every card.
  // Wiring: 6208V V0..V3 -> 1710L AI0..AI3 (A.GND-AIGND); 1710L DO0->DI0, DO1->DI1; CP-118U P1<->P2 null modem, P3 2-3 loop.
  const live = await page.evaluate(async ({ cards }) => {
    const api = window.hardwareharness;
    const names: Record<string, string> = {};
    for (const id of Object.values(cards)) {
      for (const tool of (await api.testing.listDeviceTools(id)).tools) names[`${id}/${tool.toolName}`] = tool.publicToolName;
    }
    const call = async (hardwareId: string, toolName: string, args: Record<string, unknown> = {}) => {
      try {
        const result = await api.manual.invokeTool({ hardwareId, toolName: names[`${hardwareId}/${toolName}`] ?? toolName, arguments: args });
        return { toolName, args, ok: true, result: (result.result ?? result) as any };
      } catch (error) {
        return { toolName, args, ok: false, error: String(error), result: undefined as any };
      }
    };
    const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
    const keys: Record<string, string[]> = {
      [cards.ai]: ["ai0", "ai1", "ai2", "ai3", "di", "do"],
      [cards.ao]: ["ao0", "ao1", "ao2", "ao3"],
      [cards.serial]: ["serial1", "serial2", "serial3"]
    };
    // One live subscription for every stream; the newest entry of each is kept.
    const reads: Record<string, unknown> = {};
    const streamKeys = Object.entries(keys).flatMap(([id, streamIds]) => streamIds.map((streamId) => `${id}__${streamId}`));
    const stopLive = api.streams.live({ keys: streamKeys, width: 200, windowMs: 60_000 }, (frame) => {
      for (const [key, entry] of Object.entries(frame.streams)) reads[key] = entry;
    });
    const calls: Awaited<ReturnType<typeof call>>[] = [];
    const run = async (hardwareId: string, toolName: string, args: Record<string, unknown> = {}) => {
      const item = await call(hardwareId, toolName, args);
      calls.push(item);
      return item;
    };
    const checks: { name: string; expected: unknown; actual: unknown; ok: boolean }[] = [];
    const check = (name: string, expected: unknown, actual: unknown, ok: boolean) => checks.push({ name, expected, actual, ok });
    const value = (item: { result: any }) => item.result?.output ?? item.result?.structuredContent ?? item.result;

    for (const id of Object.values(cards)) await run(id, "get_hardware_info");
    for (const channel of [0, 1, 2, 3]) await run(cards.ai, "pci1710l_configure_ai", { channel, signal_type: 0, value_range: 1 });

    // AO -> AI at several levels on each wired channel.
    for (const set of [[2.5, -1.25, 5.0, -7.5], [-4.0, 8.0, 0.0, 1.0]]) {
      for (const [channel, volts] of set.entries()) await run(cards.ao, "pci6208v_set_voltage", { channel, volts });
      await sleep(200);
      for (const [channel, volts] of set.entries()) {
        const read = await run(cards.ai, "pci1710l_read_voltage", { channel });
        const got = value(read);
        const v = Number(got?.volts ?? got?.voltage ?? got?.value ?? got?.v);
        check(`AO${channel}=${volts} -> AI${channel}`, volts, got, Math.abs(v - volts) <= 0.05);
      }
    }

    // DO -> DI on the 1710L.
    for (const [do0, do1] of [[true, false], [false, true], [false, false], [true, true]]) {
      await run(cards.ai, "pci1710l_set_level", { channel: 0, level: do0 });
      await run(cards.ai, "pci1710l_set_level", { channel: 1, level: do1 });
      await sleep(50);
      for (const [channel, level] of [[0, do0], [1, do1]]) {
        const read = await run(cards.ai, "pci1710l_read_bit", { channel, kind: "DI" });
        const got = value(read);
        const bit = got?.level ?? got?.value ?? got?.state;
        check(`DO${channel}=${level} -> DI${channel}`, level, got, Boolean(bit) === level);
      }
    }

    // Serial: P1 <-> P2 and P3 self loop.
    for (const channel of [1, 2, 3]) {
      await run(cards.serial, "cp118u_configure_port", { channel, baud: 9600 });
      await run(cards.serial, "cp118u_clear_rx", { channel });
    }
    const serialCases: [number, number, string][] = [[1, 2, "HH P1->P2\r\n"], [2, 1, "HH P2->P1\r\n"], [3, 3, "HH P3 loop\r\n"]];
    for (const [from, to, text] of serialCases) {
      await run(cards.serial, "cp118u_write_text", { channel: from, text });
      const read = await run(cards.serial, "cp118u_read_rx", { channel: to, timeout_ms: 300 });
      check(`P${from} -> P${to}`, text, value(read)?.text, String(value(read)?.text ?? "").includes(text));
    }
    await run(cards.serial, "cp118u_write_hex", { channel: 1, hex_data: "55 aa 01 02" });
    const hex = await run(cards.serial, "cp118u_read_rx", { channel: 2, timeout_ms: 300 });
    check("P1 hex -> P2", "55 aa 01 02", value(hex)?.hex, String(value(hex)?.hex ?? "").includes("55 aa 01 02"));
    const transact = await run(cards.serial, "cp118u_transact", { streamId: "serial3", data: "PING-3\r\n", expect: "PING-3", timeoutMs: 1000 });
    check("P3 transact", "PING-3", value(transact), transact.ok && value(transact)?.matched === true);
    await run(cards.serial, "cp118u_get_line_status", { channel: 3 });

    await sleep(1500);
    stopLive();
    return { checks, calls, reads };
  }, { cards: CARDS });
  await dump("2-live", live);
  const failed = [...live.calls.filter((item) => !item.ok).map((item) => ({ name: item.toolName })),
    ...live.checks.filter((item) => !item.ok)];
  // HARDWAREHARNESS_BENCH_LENIENT=1 records loopback mismatches (known wiring faults) without blocking the later tests.
  if (process.env.HARDWAREHARNESS_BENCH_LENIENT === "1") {
    for (const item of failed) test.info().annotations.push({ type: "check-failed", description: item.name });
  } else expect(failed).toEqual([]);
});

test("live data page", async () => {
  await page.reload();
  await page.getByText("bench-project", { exact: true }).first().click();
  await page.getByRole("tab", { name: "设备管理" }).click();
  for (const [name, label] of [["ao", "PCI-6208V"], ["ai", "PCI-1710L"], ["serial", "CP-118U-I"], ["relay", "PCI-1762"]]) {
    await page.getByRole("treeitem", { name: new RegExp(`^${label} `) }).click();
    await page.getByRole("button", { name: "开始监视" }).click();
    await page.getByRole("button", { name: "停止" }).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(outDir, `live-${name}.png`) });
  }
});

test("plan run with invoke / observe / expect / guard", async () => {
  const run = await page.evaluate(async ({ cards }) => {
    const api = window.hardwareharness;
    const tools: Record<string, { toolName: string; bindingRevision: string }> = {};
    for (const id of Object.values(cards)) {
      for (const tool of (await api.testing.listDeviceTools(id)).tools) tools[`${id}/${tool.toolName}`] = tool;
    }
    let n = 0;
    const invoke = (hardwareId: string, toolName: string, args: Record<string, unknown>, anchor?: string) => ({
      id: `inv${++n}`, type: "InvokeTool", name: `${toolName}`, hardwareId, toolName,
      bindingRevision: tools[`${hardwareId}/${toolName}`]!.bindingRevision, arguments: args, ...(anchor ? { anchor } : {})
    });
    const created = await api.testing.createPlan({ requestId: crypto.randomUUID(), name: "Bench self-check" });
    const plan = structuredClone(created.plan) as Record<string, any>;
    const aiWithin = (id: string, name: string, streamId: string, anchor: string, volts: number) => ({
      id, type: "Observe", name, hardwareId: cards.ai, streamId, window: { anchor, startMs: 150, endMs: 1150 },
      assertions: [{ metric: "count", op: "ge", value: 3 }, { metric: "mean", op: "within", value: [volts - 0.05, volts + 0.05] },
        { metric: "p2p", op: "le", value: 0.05 }]
    });
    plan.regions = {
      prepare: [
        ...[0, 1].map((channel) => invoke(cards.ai, "pci1710l_configure_ai", { channel, signal_type: 0, value_range: 1 })),
        ...[1, 2, 3].map((channel) => invoke(cards.serial, "cp118u_configure_port", { channel, baud: 9600 })),
        invoke(cards.ai, "pci1710l_set_level", { channel: 0, level: false })
      ],
      test: [
        // AO -> AI: the AI stream is a real measurement of the commanded AO.
        invoke(cards.ao, "pci6208v_set_voltage", { channel: 0, volts: 1.25 }, "ao_set"),
        { id: "ao_expect", type: "Expect", name: "AO0 = 1.25 V", hardwareId: cards.ao, streamId: "ao0", anchor: "ao_set",
          offsetMs: -500, withinMs: 1000, match: { op: "ge", value: 1.2 } },
        { id: "ai_rise", type: "Expect", name: "AI0 到达 1.2 V", hardwareId: cards.ai, streamId: "ai0", anchor: "ao_set",
          offsetMs: 0, withinMs: 1000, match: { op: "ge", value: 1.2 } },
        aiWithin("ai_observe", "AI0 ≈ 1.25 V", "ai0", "ao_set", 1.25),
        invoke(cards.ao, "pci6208v_set_voltage", { channel: 0, volts: -3.3 }, "ao_neg"),
        aiWithin("ai_neg", "AI0 ≈ -3.3 V", "ai0", "ao_neg", -3.3),
        invoke(cards.ao, "pci6208v_set_voltage", { channel: 1, volts: 6.0 }, "ao1_set"),
        aiWithin("ai1_observe", "AI1 ≈ 6.0 V", "ai1", "ao1_set", 6.0),
        // DO -> DI: edge detection on the looped bit plus the held level.
        invoke(cards.ai, "pci1710l_set_level", { channel: 0, level: true }, "do_hi"),
        { id: "di_rise", type: "Expect", name: "DI0 上升沿", hardwareId: cards.ai, streamId: "di", anchor: "do_hi",
          offsetMs: 0, withinMs: 1000, match: { bit: 0, level: true } },
        { id: "di_hi", type: "Observe", name: "DI0 保持高", hardwareId: cards.ai, streamId: "di",
          window: { anchor: "do_hi", startMs: 200, endMs: 600 }, assertions: [{ metric: "bit0.last", op: "eq", value: 1 }] },
        invoke(cards.ai, "pci1710l_set_level", { channel: 0, level: false }, "do_lo"),
        { id: "di_fall", type: "Expect", name: "DI0 下降沿", hardwareId: cards.ai, streamId: "di", anchor: "do_lo",
          offsetMs: 0, withinMs: 1000, match: { bit: 0, level: false } },
        { id: "di_lo", type: "Observe", name: "DI0 保持低", hardwareId: cards.ai, streamId: "di",
          window: { anchor: "do_lo", startMs: 200, endMs: 600 }, assertions: [{ metric: "bit0.last", op: "eq", value: 0 }] },
        // Serial: P1 -> P2 across the null modem, P3 onto itself.
        invoke(cards.serial, "cp118u_write_text", { channel: 1, text: "HH-PING\r\n" }, "tx"),
        { id: "tx_expect", type: "Expect", name: "P1 发出 HH-PING", hardwareId: cards.serial, streamId: "serial1", anchor: "tx",
          offsetMs: -500, withinMs: 1000, match: { dir: "tx", pattern: "HH-PING" } },
        { id: "rx_expect", type: "Expect", name: "P2 收到 HH-PING", hardwareId: cards.serial, streamId: "serial2", anchor: "tx",
          offsetMs: 0, withinMs: 1000, match: { dir: "rx", pattern: "HH-PING" } },
        invoke(cards.serial, "cp118u_write_hex", { channel: 3, hex_data: "a5 5a 10 20" }, "tx3"),
        { id: "rx3_expect", type: "Expect", name: "P3 自环收到 a55a1020", hardwareId: cards.serial, streamId: "serial3", anchor: "tx3",
          offsetMs: 0, withinMs: 1000, match: { dir: "rx", hex: "a55a1020" } },
        { id: "ai_guard", type: "Guard", name: "AI0 < 5 V", hardwareId: cards.ai, streamId: "ai0",
          condition: { op: "lt", value: 5 }, onViolation: "fail", children: [
            invoke(cards.ao, "pci6208v_set_voltage", { channel: 0, volts: 3.3 }, "ao_step"),
            { id: "hold", type: "Delay", durationMs: 800 }
          ] }
      ],
      cleanup: [
        invoke(cards.ao, "pci6208v_safe_state", {}),
        invoke(cards.relay, "pci1762_safe_state", {}),
        invoke(cards.ai, "pci1710l_safe_state", {}),
        invoke(cards.serial, "cp118u_safe_state", {})
      ]
    };
    const saved = await api.testing.savePlan(plan as never, created.plan.revision);
    const validation = await api.testing.validatePlan(saved.plan.id);
    if (!validation.valid) return { saveIssues: saved.issues, validation };
    let snapshot = await api.testing.startRun({
      planId: saved.plan.id, revision: saved.plan.revision, executionRevision: validation.executionRevision,
      requestId: crypto.randomUUID(), parameters: {}
    });
    const deadline = Date.now() + 120_000;
    while (!["completed", "aborted", "error"].includes(snapshot.state) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 500));
      snapshot = await api.testing.getRun(snapshot.runId);
    }
    const runId = snapshot.runId;
    return {
      validation, snapshot,
      results: await api.testing.readRunResults(runId),
      timeline: await api.testing.getRunTimeline(runId),
      streams: await api.testing.listRunStreams(runId),
      io: await api.testing.readRunIo(runId, null, 50),
      rejudge: await api.testing.rejudgeRun(runId)
    };
  }, { cards: CARDS });
  await dump("3-run", run);
  expect(run.snapshot?.state).toBe("completed");
});

test("run monitor page", async () => {
  await page.getByRole("tab", { name: "运行监控" }).click();
  await page.getByRole("list", { name: "运行记录" }).getByRole("button").first().click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(outDir, "monitor.png") });
  // Zoom to a step from the overview, then read the console in hex and the scope with all channels overlaid.
  await page.locator("[data-overview-step]").nth(4).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(outDir, "monitor-step.png") });
  await page.getByRole("group", { name: "总线显示格式" }).getByRole("button", { name: "HEX" }).click();
  await page.getByRole("group", { name: "通道布局" }).getByRole("button", { name: "叠加" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(outDir, "monitor-overlay.png") });
  await dump("5-log-overflow", await page.evaluate(() => {
    const scroller = [...document.querySelectorAll<HTMLElement>("main[aria-label='运行监控'] .overflow-auto")]
      .find((element) => element.scrollWidth > element.clientWidth);
    if (!scroller) return { overflow: false };
    const right = scroller.getBoundingClientRect().left + scroller.clientWidth;
    const leaf = [...scroller.querySelectorAll<HTMLElement>("*")]
      .find((element) => element.getBoundingClientRect().right > right + 1);
    const wide: { tag: string; className: string; width: number }[] = [];
    for (let node = leaf; node && node !== scroller; node = node.parentElement ?? undefined) {
      wide.push({ tag: node.tagName, className: node.className.toString(), width: node.getBoundingClientRect().width });
    }
    return { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth, wide };
  }));
  await dump("4-di", await page.evaluate(async () => {
    const api = window.hardwareharness.testing;
    const [latest] = (await api.listRuns({})).items;
    const timeline = await api.getRunTimeline(latest!.runId);
    const keys = timeline.streams.filter((stream) => stream.type === "bits").map((stream) => stream.key);
    return Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await api.readRunStream(latest!.runId, key,
      { t0: timeline.tb0! - 1000, t1: timeline.tb1! + 500, maxPoints: 2000 })])));
  }));
});
