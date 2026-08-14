import { describe, expect, it, vi } from "vitest";
import type { Hardware } from "@testforge/contracts/devices";
import type { ProjectDocument } from "@testforge/contracts/projects";
import type { ProjectWiring } from "@testforge/contracts/wiring";
import { ProjectWiringService } from "./project-wiring-service.js";

const timestamp = "2026-08-07T00:00:00.000Z";

function hardware(hardwareId: string, kind: "managed" | "passive"): Hardware {
  return {
    formatVersion: 2,
    hardwareId,
    label: hardwareId,
    kind,
    ...(kind === "managed" ? { serverId: "SERVER", computerId: "COMPUTER" } : {}),
    ports: [{ portId: "P1", name: "P1", pins: [] }, { portId: "P2", name: "P2", pins: [] }],
  };
}

function fixture() {
  let dirty = false;
  let wiring: ProjectWiring = {
    nodes: [{ hardwareId: "DUT_A", x: 10, y: 20, showImage: true, portPositions: {} }],
    connections: [{ connectionId: "C1", portA: "DUT_A.P1", portB: "DUT_B.P1", pins: [], confirmedAt: timestamp, confirmedBy: "operator" }]
  };
  const records = new Map([hardware("CARD_A", "managed"), hardware("DUT_A", "passive")].map((item) => [item.hardwareId, item]));
  const document = (): ProjectDocument => ({
    rootPath: "C:\\workspace\\project",
    path: "C:\\workspace\\project\\.testforge\\project.json",
    dirty,
    file: {
      formatVersion: 3, projectId: "PROJECT", name: "Project", wiring: structuredClone(wiring),
      task: { formatVersion: 2, taskId: "TASK", name: "Task", inputs: [], variables: [], setup: [], steps: [], cleanup: [] },
      createdAt: timestamp, updatedAt: timestamp
    }
  });
  const projects = {
    wiring: () => structuredClone(wiring),
    document,
    updateWiring: (next: ProjectWiring) => { wiring = structuredClone(next); dirty = true; return document(); }
  };
  const catalog = {
    getHardware: (hardwareId: string) => {
      const item = records.get(hardwareId);
      if (!item) throw new Error(`Unknown hardwareId: ${hardwareId}`);
      return item;
    }
  };
  const service = new ProjectWiringService(projects as never, catalog as never);
  const projectNotifier = vi.fn();
  service.setProjectNotifier(projectNotifier);
  return { service, projects, projectNotifier };
}

describe("Agent canvas permissions", () => {
  it("adds a managed node without changing physical connections", async () => {
    const { service, projects, projectNotifier } = fixture();
    const beforeConnections = projects.wiring().connections;

    const added = await service.addManagedHardwareToCanvas("CARD_A");

    expect(added).toMatchObject({ added: true, dirty: true, node: { hardwareId: "CARD_A", x: 410, y: 80 } });
    expect(added.node.portPositions).toEqual({ P1: { side: "left", offset: 0.5 }, P2: { side: "right", offset: 0.5 } });
    expect(projects.wiring().connections).toEqual(beforeConnections);
    expect(projectNotifier).toHaveBeenCalledTimes(1);
  });

  it("is idempotent and refuses passive hardware", async () => {
    const { service, projects, projectNotifier } = fixture();
    const first = await service.addManagedHardwareToCanvas("CARD_A");
    const repeated = await service.addManagedHardwareToCanvas("CARD_A");

    expect(repeated).toEqual({ added: false, dirty: true, node: first.node });
    expect(projects.wiring().nodes.filter((node) => node.hardwareId === "CARD_A")).toHaveLength(1);
    expect(projectNotifier).toHaveBeenCalledTimes(1);
    await expect(service.addManagedHardwareToCanvas("DUT_A")).rejects.toMatchObject({ category: "permission_denied" });
  });
});
