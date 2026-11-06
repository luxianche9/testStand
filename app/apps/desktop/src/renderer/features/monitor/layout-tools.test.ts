// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { deletePreset, exportText, generatedLayout, importText, readPresets, savePreset } from "./layout-tools.js";

const s = (streamId: string, type: string, declaration?: Record<string, unknown>) =>
  ({ hardwareId: "D", streamId, type, declaration });

describe("layout tools", () => {
  beforeEach(() => globalThis.localStorage?.clear());

  it("generates panels by stream type, each in the next free spot", () => {
    const panels = generatedLayout([
      s("ai0", "block", { kind: "measured" }), s("ao0", "scalar", { kind: "setpoint" }),
      s("do", "bits"), s("status", "bits", { display: "code" }), s("serial0", "bytes"), s("can0", "frames")
    ]);
    expect(panels.map((panel) => [panel.id, panel.sources.map((item) => item.streamId), panel.frame])).toEqual([
      ["scope", ["ai0"], { x: 0, y: 0, w: 30, h: 14 }],
      ["values", ["ai0", "ao0"], { x: 30, y: 0, w: 20, h: 10 }],
      ["digital", ["do"], { x: 30, y: 10, w: 20, h: 7 }],
      ["register", ["status"], { x: 0, y: 14, w: 14, h: 9 }],
      ["terminal", ["serial0"], { x: 14, y: 17, w: 24, h: 12 }],
      ["trace", ["can0"], { x: 0, y: 29, w: 30, h: 14 }]
    ]);
  });

  it("leaves out panels without streams", () => {
    expect(generatedLayout([s("serial0", "bytes")]).map((panel) => panel.id)).toEqual(["terminal"]);
  });

  it("keeps presets by name and round-trips exported workspaces", () => {
    const frame = { x: 0, y: 0, w: 4, h: 4 };
    const monitor = { panels: [{ id: "a", type: "scope" as const, sources: [], settings: {}, frame }] };
    savePreset("台架", monitor, new Date("2026-10-12T00:00:00Z"));
    savePreset("台架", { panels: [{ ...monitor.panels[0]!, frame: { ...frame, x: 3 } }] });
    expect(readPresets().map((item) => [item.name, item.monitor.panels[0]?.frame?.x])).toEqual([["台架", 3]]);
    expect(deletePreset("台架")).toEqual([]);
    expect(importText(exportText(monitor))).toEqual(monitor);
    expect(importText("{}")).toBe("不是 testStand 运行监控布局文件");
    expect(importText("nope")).toMatch(/^无法读取布局文件/);
  });
});
