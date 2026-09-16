import { describe, expect, it } from "vitest";
import { projectViewSchema, userSettingsSchema } from "./storage.js";
import { executionActivitySchema } from "./execution.js";
import { HARDWAREHARNESS_IPC } from "./desktop.js";

describe("retired workflow compatibility", () => {
  it.each(["applications", "logs", "orchestration", "unknown"])("restores %s to wiring without losing settings", (view) => {
    expect(projectViewSchema.parse(view)).toBe("wiring");
    expect(userSettingsSchema.parse({ projectView: view, theme: "dark" })).toMatchObject({ projectView: "wiring", theme: "dark" });
  });

  it("keeps both supported views and excludes retired IPC", () => {
    expect(projectViewSchema.parse("manual")).toBe("manual");
    expect(projectViewSchema.parse("wiring")).toBe("wiring");
    expect(HARDWAREHARNESS_IPC).not.toHaveProperty("applications");
  });

  it("accepts direct hardware activities and rejects Python runs", () => {
    const call = { state: "manual", hardwareId: "H", toolName: "S__write", startedAt: "2026-09-16T00:00:00.000Z" };
    expect(executionActivitySchema.parse({ ...call, activities: [call, { ...call, hardwareId: "H2" }] })).toMatchObject({ state: "manual" });
    expect(executionActivitySchema.safeParse({ state: "run", runId: "R", hardwareIds: ["H"], startedAt: call.startedAt }).success).toBe(false);
  });
});
