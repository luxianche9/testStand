import { describe, expect, it } from "vitest";
import { agentKindInputSchema } from "./agents.js";
import { appError, toWireError } from "./errors.js";
import { assetIdInputSchema, computerIdInputSchema, deviceBundleIdInputSchema, hardwareIdInputSchema, hardwareSchema, managedHardwareSchema, mcpServerSchema, remoteComputerSchema, serverIdInputSchema } from "./devices.js";
import { projectFileSchema, projectRootPathInputSchema } from "./projects.js";
import { wiringTaskIdInputSchema } from "./wiring.js";

describe("public contracts", () => {
  it("rejects passive hardware that references remote infrastructure", () => {
    expect(() => hardwareSchema.parse({ formatVersion: 2, hardwareId: "DUT", label: "DUT", kind: "passive", serverId: "S1", computerId: "PC1", ports: [] })).toThrow();
  });

  it("applies stable defaults", () => {
    expect(remoteComputerSchema.parse({ id: "PC1", label: "PC", address: "127.0.0.1", ssh: { username: "user" } }).ssh).toMatchObject({ port: 22, shell: "powershell" });
    expect(mcpServerSchema.parse({ serverId: "S1", computerId: "PC1", label: "S", hardwareId: "H1", url: "http://127.0.0.1/mcp", lifecycle: { statusCommand: "s", startCommand: "a", stopCommand: "x", logPath: "l" } })).toMatchObject({ transport: "mcp-http" });
  });

  it("validates managed hardware at the remote trust boundary", () => {
    expect(managedHardwareSchema.safeParse({ hardwareId: "H1", computerId: "PC1", serverId: "S1", state: "vendor-ready", health: "ok" }).success).toBe(false);
  });

  it("requires the current project format", () => {
    expect(() => projectFileSchema.parse({ formatVersion: 2 })).toThrow();
  });

  it("accepts current project metadata without node tasks", () => {
    const timestamp = "2026-08-15T00:00:00.000Z";
    const project = { formatVersion: 4, projectId: "PROJECT", name: "Bench", wiring: { nodes: [], connections: [] }, createdAt: timestamp, updatedAt: timestamp };
    expect(projectFileSchema.parse(project)).toEqual(project);
    expect(projectFileSchema.parse({ ...project, task: {}, ignored: true })).toEqual(project);
    expect(projectFileSchema.safeParse({ ...project, formatVersion: 3 }).success).toBe(false);
  });

  it("uses strict named id inputs for IPC procedures", () => {
    const schemas = [computerIdInputSchema, serverIdInputSchema, hardwareIdInputSchema, assetIdInputSchema, deviceBundleIdInputSchema, projectRootPathInputSchema, wiringTaskIdInputSchema];
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
});
