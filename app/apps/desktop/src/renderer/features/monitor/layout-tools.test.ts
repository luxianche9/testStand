// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { deletePreset, exportText, generatedLayout, importText, readPresets, savePreset } from "./layout-tools.js";

const s = (streamId: string, type: string, declaration?: Record<string, unknown>) =>
  ({ hardwareId: "D", streamId, type, declaration });

describe("layout tools", () => {
  beforeEach(() => globalThis.localStorage?.clear());

  it("generates panels by stream type", () => {
    const panels = generatedLayout([
      s("ai0", "block", { kind: "measured" }), s("ao0", "scalar", { kind: "setpoint" }),
      s("do", "bits"), s("status", "bits", { display: "code" }), s("serial0", "bytes"), s("can0", "frames")
    ]);
    expect(panels.map((panel) => [panel.id, panel.sources.map((item) => item.streamId), panel.placement])).toEqual([
      ["sources", [], undefined],
      ["scope", ["ai0"], { referenceId: "sources", direction: "right" }],
      ["digital", ["do"], { referenceId: "scope", direction: "below" }],
      ["register", ["status"], { referenceId: "digital", direction: "within" }],
      ["terminal", ["serial0"], { referenceId: "register", direction: "below" }],
      ["trace", ["can0"], { referenceId: "terminal", direction: "within" }],
      ["values", ["ai0", "ao0"], { referenceId: "scope", direction: "right" }],
      ["inspector", [], { referenceId: "values", direction: "below" }]
    ]);
  });

  it("leaves out panels without streams", () => {
    expect(generatedLayout([s("serial0", "bytes")]).map((panel) => panel.id))
      .toEqual(["sources", "terminal", "inspector"]);
  });

  it("keeps presets by name and round-trips exported workspaces", () => {
    const monitor = { panels: [{ id: "a", type: "scope" as const, sources: [], settings: {} }], layout: null };
    savePreset("台架", monitor, new Date("2026-10-12T00:00:00Z"));
    savePreset("台架", { ...monitor, layout: { grid: {} } });
    expect(readPresets().map((item) => [item.name, item.monitor.layout])).toEqual([["台架", { grid: {} }]]);
    expect(deletePreset("台架")).toEqual([]);
    expect(importText(exportText(monitor))).toEqual(monitor);
    expect(importText("{}")).toBe("不是 testStand 运行监控布局文件");
    expect(importText("nope")).toMatch(/^无法读取布局文件/);
  });
});
