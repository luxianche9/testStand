import { describe, expect, it } from "vitest";
import { projectViewSchema, userSettingsSchema } from "./storage.js";
import { executionActivitySchema } from "./execution.js";
import { DESKTOP_OPERATIONS } from "./application.js";

describe("retired workflow compatibility", () => {
  it.each(["applications", "logs", "orchestration", "unknown"])("restores %s to wiring without losing settings", (view) => {
    expect(projectViewSchema.parse(view)).toBe("wiring");
    expect(userSettingsSchema.parse({ projectView: view, theme: "dark" })).toMatchObject({ projectView: "wiring", theme: "dark" });
  });

  it("keeps supported views and excludes retired application IPC", () => {
    expect(projectViewSchema.parse("manual")).toBe("manual");
    expect(projectViewSchema.parse("wiring")).toBe("wiring");
    expect(projectViewSchema.parse("plans")).toBe("plans");
    expect(projectViewSchema.parse("runs")).toBe("runs");
    expect(DESKTOP_OPERATIONS.some((operation) => operation.startsWith("applications."))).toBe(false);
  });

  it("accepts direct hardware and test-run activities", () => {
    const call = { state: "manual", hardwareId: "H", toolName: "S__write", startedAt: "2026-09-16T00:00:00.000Z" };
    expect(executionActivitySchema.parse({ ...call, activities: [call, { ...call, hardwareId: "H2" }] })).toMatchObject({ state: "manual" });
    expect(executionActivitySchema.parse({ state: "run", runId: "R", hardwareIds: ["H"], startedAt: call.startedAt })).toMatchObject({ state: "run", runId: "R" });
  });
});
