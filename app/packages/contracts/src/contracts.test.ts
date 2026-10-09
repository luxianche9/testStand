import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { agentKindInputSchema } from "./agents.js";
import { appError, toWireError } from "./errors.js";
import { deviceBundleIdInputSchema, hardwareIdInputSchema, hardwareSchema, managedHardwareSchema, deviceInstanceSchema, deviceIdInputSchema } from "./devices.js";
import { projectFileSchema, projectRootPathInputSchema } from "./projects.js";
import { projectWiringSchema, wiringTaskIdInputSchema } from "./wiring.js";

describe("public contracts", () => {
  it("rejects passive hardware that references remote infrastructure", () => {
    expect(() => hardwareSchema.parse({ formatVersion: 2, hardwareId: "DUT", label: "DUT", kind: "passive", deviceId: "S1", ports: [] })).toThrow();
  });

  it("applies stable defaults", () => {
    expect(deviceInstanceSchema.parse({ deviceId: "P1", label: "P", hardwareId: "H2", type: "pci1762" })).toMatchObject({ settings: {}, enabled: true });
    expect(deviceInstanceSchema.safeParse({ deviceId: "S3", computerId: "PC1", label: "S", hardwareId: "H3", type: "pci1762" }).success).toBe(false);
  });

  it("validates managed hardware at the device trust boundary", () => {
    expect(managedHardwareSchema.safeParse({ hardwareId: "H1", deviceId: "S1", state: "vendor-ready", health: "ok" }).success).toBe(false);
  });

  it("requires the current project format", () => {
    expect(() => projectFileSchema.parse({ formatVersion: 2 })).toThrow();
  });

  it("accepts current project metadata without node tasks", () => {
    const timestamp = "2026-08-15T00:00:00.000Z";
    const project = {
      formatVersion: 7, projectId: "PROJECT", name: "Bench", wiring: { nodes: [], connections: [] },
      monitor: { channels: [] }, createdAt: timestamp, updatedAt: timestamp
    };
    expect(projectFileSchema.parse(project)).toEqual(project);
    expect(projectFileSchema.parse({ ...project, task: {}, ignored: true })).toEqual(project);
    expect(projectFileSchema.safeParse({ ...project, formatVersion: 6 }).success).toBe(false);
  });

  it("keeps a canvas card's size and port placement", () => {
    const node = {
      hardwareId: "DUT", x: 40, y: 80, width: 260, height: 180,
      portPositions: { J1: { side: "left", offset: 0.25 } }
    };
    expect(projectWiringSchema.parse({ nodes: [node], connections: [] }).nodes[0]).toEqual(node);
    // A card without an explicit placement still parses: the canvas falls back to even spacing.
    expect(projectWiringSchema.parse({ nodes: [{ hardwareId: "DUT", x: 0, y: 0 }], connections: [] })
      .nodes[0]?.portPositions).toEqual({});
    expect(projectWiringSchema.safeParse({
      nodes: [{ hardwareId: "DUT", x: 0, y: 0, portPositions: { J1: { side: "left", offset: 2 } } }],
      connections: []
    }).success).toBe(false);
  });

  it("uses strict named id inputs for IPC procedures", () => {
    const schemas = [deviceIdInputSchema, hardwareIdInputSchema, deviceBundleIdInputSchema, projectRootPathInputSchema, wiringTaskIdInputSchema];
    for (const schema of schemas) {
      expect(schema.parse({ id: "ID" })).toEqual({ id: "ID" });
      expect(schema.safeParse({ id: "ID", extra: true }).success).toBe(false);
    }
    expect(agentKindInputSchema.parse({ id: "codex" })).toEqual({ id: "codex" });
  });

  it("normalizes application errors for wire transport", () => {
    expect(toWireError(appError("conflict", "busy", { holder: "run" }))).toEqual({ category: "conflict", message: "busy", details: { holder: "run" } });
    expect(toWireError(new Error("boom"))).toEqual({ category: "error", message: "boom" });
  });

  it("keeps the request types in step with openapi.json", async () => {
    const script = fileURLToPath(new URL("../scripts/generate-openapi-types.mjs", import.meta.url));
    await expect(promisify(execFile)(process.execPath, [script, "--check"])).resolves.toBeDefined();
  }, 30_000);
});
