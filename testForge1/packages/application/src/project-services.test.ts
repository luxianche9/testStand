import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { Hardware } from "@testforge/contracts/devices";
import type { TestTask } from "@testforge/contracts/orchestration";
import { DeviceCatalogService, DeviceStore } from "@testforge/devices";
import { ProjectService } from "@testforge/projects";
import { SettingsStore } from "@testforge/storage";
import { ProjectWiringService } from "@testforge/wiring";
import { setWorkflowPath, validateTestTask } from "@testforge/orchestration";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function passiveHardware(hardwareId: string): Hardware {
  return {
    formatVersion: 2, hardwareId, label: hardwareId, kind: "passive",
    ports: [
      { portId: "J1", name: "J1", pins: [{ pinId: "1", position: 1, label: "A" }, { pinId: "2", position: 2, label: "B" }] },
      { portId: "FIBER", name: "光纤口", pins: [] }
    ]
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "testforge-project-")); roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json")); await settings.initialize();
  const projects = new ProjectService(settings);
  await projects.initialize();
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  await projects.initializeFolder(projectRoot);
  const store = new DeviceStore(join(root, "devices"));
  await store.initialize();
  const catalog = new DeviceCatalogService(store);
  for (const hardwareId of ["DUT_A", "DUT_B"]) await catalog.saveHardware(passiveHardware(hardwareId));
  const wiring = new ProjectWiringService(projects, catalog);
  await wiring.initialize();
  return { projects, wiring, catalog, root, projectRoot };
}

describe("project-oriented services", () => {
  it("keeps the wiring canvas documentary while the operator processes a task", async () => {
    const { projects, wiring } = await fixture();
    projects.updateWiring({ nodes: [{ hardwareId: "DUT_A", x: 10, y: 20, showImage: true, portPositions: {} }], connections: [] });
    const task = await wiring.requestTask({
      portA: "DUT_A.J1", portB: "DUT_B.J1",
      pins: [{ a: "1", b: "1" }, { a: "2", b: "2" }],
      action: "connect"
    });
    expect(task.status).toBe("pending");
    // Neither port has a photo yet, and the operator needs one to work from.
    expect(task.warnings.length).toBeGreaterThan(0);
    const started = await wiring.startTask(task.wiringTaskId, "tester");
    expect(started.status).toBe("in_progress");
    const confirmed = await wiring.completeTask(task.wiringTaskId, "confirmed");
    expect(confirmed.status).toBe("confirmed");
    // One cable, one record — the two pin pairs travel inside it rather than as separate rows.
    const connections = projects.wiring().connections;
    expect(connections).toHaveLength(1);
    expect(connections[0]!.pins).toEqual([{ a: "1", b: "1" }, { a: "2", b: "2" }]);
    expect(projects.document().dirty).toBe(true);
    await projects.close();
  });

  it("records a pinless connection for connectors that have no pins", async () => {
    const { projects, wiring } = await fixture();
    const task = await wiring.requestTask({ portA: "DUT_A.FIBER", portB: "DUT_B.FIBER", action: "connect" });
    await wiring.startTask(task.wiringTaskId, "tester");
    await wiring.completeTask(task.wiringTaskId, "confirmed");
    const connections = projects.wiring().connections;
    expect(connections).toHaveLength(1);
    expect(connections[0]!.pins).toEqual([]);
    await projects.close();
  });

  it("normalises port order so one cable cannot be requested twice under swapped ends", async () => {
    const { projects, wiring } = await fixture();
    const first = await wiring.requestTask({ portA: "DUT_B.J1", portB: "DUT_A.J1", pins: [{ a: "1", b: "2" }], action: "connect" });
    // Sorting the ends swaps the pin pair with them, so each side still points at its own port.
    expect(first.portA).toBe("DUT_A.J1");
    expect(first.pins).toEqual([{ a: "2", b: "1" }]);
    await expect(wiring.requestTask({ portA: "DUT_A.J1", portB: "DUT_B.J1", action: "connect" })).rejects.toThrow(/already exists/);
    await projects.close();
  });

  it("refuses pin pairs that name a pin the port does not have", async () => {
    const { projects, wiring } = await fixture();
    await expect(wiring.requestTask({ portA: "DUT_A.J1", portB: "DUT_B.J1", pins: [{ a: "9", b: "1" }], action: "connect" }))
      .rejects.toThrow(/has no pin 9/);
    await projects.close();
  });

  it("round-trips one folder project with wiring and one task", async () => {
    const { projects, root, projectRoot } = await fixture();
    projects.updateWiring({ nodes: [{ hardwareId: "DUT_A", x: 1, y: 2, showImage: true, portPositions: {} }], connections: [] });
    projects.updateTask({
      formatVersion: 2, taskId: "TASK_A", name: "Voltage", inputs: [], variables: [], setup: [], steps: [], cleanup: []
    });
    await projects.save();
    expect(projects.document().dirty).toBe(false);
    const otherRoot = join(root, "other");
    await mkdir(otherRoot);
    await projects.initializeFolder(otherRoot);
    expect(projects.wiring().nodes).toHaveLength(0);
    await projects.openFolder(projectRoot);
    expect(projects.wiring().nodes[0]?.hardwareId).toBe("DUT_A");
    expect(projects.task().taskId).toBe("TASK_A");
    await projects.close();
  });

  it("rejects prototype paths and parallel shared writes", () => {
    expect(() => setWorkflowPath(Object.create(null) as Record<string, unknown>, "__proto__.polluted", true)).toThrow(/Unsafe/);
    const context = Object.assign(Object.create(null) as Record<string, unknown>, { declared: 0 });
    expect(() => setWorkflowPath(context, "declared.child", true)).toThrow(/top-level/);
    expect(() => setWorkflowPath(context, "misspelled", true)).toThrow(/Unknown/);
    setWorkflowPath(context, "declared", 1);
    expect(context.declared).toBe(1);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    const task: TestTask = {
      formatVersion: 2, taskId: "TASK", name: "Task", inputs: [], variables: [{ name: "result", type: "number", defaultValue: 0 }], setup: [], cleanup: [],
      steps: [{ stepId: "P", label: "Parallel", enabled: true, type: "parallel", branches: [
        { branchId: "A", name: "A", steps: [{ stepId: "WRITE", label: "Write", enabled: true, type: "set_variable", variable: "result", value: { kind: "literal", value: 1 } }] },
        { branchId: "B", name: "B", steps: [] }
      ] }]
    };
    expect(validateTestTask(task).issues.some((item) => item.code === "parallel_shared_write")).toBe(true);
  });

  it("keeps inputs read-only and validates statically known assignment types", () => {
    const task: TestTask = {
      formatVersion: 2, taskId: "TYPES", name: "Types", inputs: [{ name: "input", type: "number" }], variables: [{ name: "result", type: "number" }], setup: [], cleanup: [],
      steps: [
        { stepId: "INPUT_WRITE", label: "Input write", enabled: true, type: "set_variable", variable: "input", value: { kind: "literal", value: 1 } },
        { stepId: "BAD_TYPE", label: "Bad type", enabled: true, type: "set_variable", variable: "result", value: { kind: "literal", value: "wrong" } }
      ]
    };
    const issues = validateTestTask(task).issues;
    expect(issues.some((item) => item.nodeId === "INPUT_WRITE" && item.code === "undeclared_variable")).toBe(true);
    expect(issues.some((item) => item.nodeId === "BAD_TYPE" && item.code === "variable_type")).toBe(true);
  });
});
