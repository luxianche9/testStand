import { monitorSchema, type Monitor, type MonitorPanel, type StreamRef } from "@teststand/contracts/monitor";
import type { StreamDeclaration } from "@teststand/contracts/observability";

/** A stream as the layout generator sees it. */
export interface LayoutStream extends StreamRef {
  type: string;
  declaration?: StreamDeclaration | undefined;
}

type NewPanel = Omit<MonitorPanel, "settings"> & { settings: Record<string, unknown> };

/**
 * A layout made from the data (Rerun's heuristics): measured analog streams on an oscilloscope,
 * every scalar in a values table (setpoints can be set there), lines and relays on a digital
 * panel, status words on a register view, serial ports in a terminal, buses in a trace — with the
 * data-source tree on the left and the property panel on the right. Panels without streams are
 * left out.
 */
export function generatedLayout(streams: readonly LayoutStream[]): NewPanel[] {
  const ref = ({ hardwareId, streamId }: LayoutStream): StreamRef => ({ hardwareId, streamId });
  const of = (test: (stream: LayoutStream) => boolean) => streams.filter(test).map(ref);
  const measured = of((item) => (item.type === "block" || item.type === "scalar")
    && item.declaration?.kind !== "setpoint");
  const scalars = of((item) => item.type === "block" || item.type === "scalar");
  const codes = of((item) => item.type === "bits" && item.declaration?.display === "code");
  const lines = of((item) => item.type === "bits" && item.declaration?.display !== "code");
  const serial = of((item) => item.type === "bytes");
  const buses = of((item) => item.type === "frames");
  const panels: NewPanel[] = [{ id: "sources", type: "sources", title: "数据源", sources: [], settings: {} }];
  const add = (panel: Omit<NewPanel, "settings">, placement: MonitorPanel["placement"]) => {
    if (!panel.sources.length) return;
    const reference = placement?.referenceId;
    const known = !reference || panels.some((item) => item.id === reference);
    panels.push({ ...panel, settings: panel.type === "trace" ? { mode: "time" } : {},
      ...(placement ? { placement: known ? placement : { direction: placement.direction } } : {}) });
  };
  add({ id: "scope", type: "scope", title: "示波器", sources: measured }, { referenceId: "sources", direction: "right" });
  add({ id: "digital", type: "digital", title: "数字量", sources: lines },
    { referenceId: measured.length ? "scope" : "sources", direction: measured.length ? "below" : "right" });
  add({ id: "register", type: "register", title: "状态字", sources: codes },
    { referenceId: "digital", direction: "within" });
  const lower = panels.at(-1)?.id ?? "sources";
  add({ id: "terminal", type: "terminal", title: "串口", sources: serial }, { referenceId: lower, direction: "below" });
  add({ id: "trace", type: "trace", title: "总线跟踪", sources: buses },
    { referenceId: serial.length ? "terminal" : lower, direction: serial.length ? "within" : "below" });
  add({ id: "values", type: "values", title: "数值", sources: scalars },
    { referenceId: measured.length ? "scope" : lower, direction: "right" });
  panels.push({ id: "inspector", type: "inspector", title: "属性", sources: [], settings: {},
    placement: { referenceId: panels.some((item) => item.id === "values") ? "values" : panels.at(-1)!.id,
      direction: panels.some((item) => item.id === "values") ? "below" : "right" } });
  return panels;
}

/** A saved arrangement of the workspace, kept on this computer and usable in any project. */
export interface LayoutPreset {
  name: string;
  savedAt: string;
  monitor: Monitor;
}

const PRESETS_KEY = "teststand.monitor.presets";

export function readPresets(): LayoutPreset[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(PRESETS_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const { name, savedAt, monitor } = item as Record<string, unknown>;
      const parsed = monitorSchema.safeParse(monitor);
      return typeof name === "string" && parsed.success
        ? [{ name, savedAt: typeof savedAt === "string" ? savedAt : "", monitor: parsed.data }] : [];
    });
  } catch {
    return [];
  }
}

function writePresets(presets: readonly LayoutPreset[]): void {
  try { globalThis.localStorage?.setItem(PRESETS_KEY, JSON.stringify(presets)); } catch { /* not kept */ }
}

/** Saves (or replaces by name) a preset. */
export function savePreset(name: string, monitor: Monitor, now = new Date()): LayoutPreset[] {
  const next = [...readPresets().filter((item) => item.name !== name), { name, savedAt: now.toISOString(), monitor }];
  writePresets(next);
  return next;
}

export function deletePreset(name: string): LayoutPreset[] {
  const next = readPresets().filter((item) => item.name !== name);
  writePresets(next);
  return next;
}

/** The file a workspace is exported as. */
export function exportText(monitor: Monitor): string {
  return JSON.stringify({ kind: "teststand.monitor", formatVersion: 1, monitor }, null, 2);
}

/** A workspace from an exported file, or why it is not one. */
export function importText(text: string): Monitor | string {
  try {
    const value = JSON.parse(text) as { kind?: unknown; monitor?: unknown };
    if (value.kind !== "teststand.monitor") return "不是 testStand 运行监控布局文件";
    const parsed = monitorSchema.safeParse(value.monitor);
    return parsed.success ? parsed.data : `布局文件内容不正确：${parsed.error.issues[0]?.message ?? ""}`;
  } catch (cause) {
    return `无法读取布局文件：${cause instanceof Error ? cause.message : String(cause)}`;
  }
}
