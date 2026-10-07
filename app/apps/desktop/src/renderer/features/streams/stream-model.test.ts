import { describe, expect, it } from "vitest";
import type { RunTimeline, StreamInfo } from "@teststand/contracts/observability";
import {
  alignSeries, analogData, ansiLine, BIT_LANE, combinedOverlays, compareEntries, consoleLine, deviceName,
  formatNumber, isSampled, logicData, overlaysFor, pointAt, pointText, recordEntry, relativeTime, relevantStreams,
  runRange, scopeData, shortLabel, stepAt, streamUnit, terminalLine, timelineEntries, verdictTone
} from "./stream-model.js";

function stream(key: string, overrides: Partial<StreamInfo> = {}): StreamInfo {
  const [hardwareId = "", streamId = ""] = key.split("/");
  return {
    key, hardwareId, streamId, type: "scalar", clock: null, count: 0, first: null, last: null,
    lastI: null, watermark: null, watermarkTb: null, gaps: 0, states: [], ...overrides
  };
}

function timeline(overrides: Partial<RunTimeline> = {}): RunTimeline {
  return {
    runId: "run", tb0: 1_000, tb1: 2_000, steps: [], calls: [], anchors: [], windows: [], violations: [],
    marks: [], streams: [], gaps: [], ...overrides
  };
}

describe("stream model", () => {
  it("draws scalar, block and bit streams on a scope and the rest in a terminal", () => {
    expect(["scalar", "block", "bits"].every(isSampled)).toBe(true);
    expect(["bytes", "frames", "events", "blob"].some(isSampled)).toBe(false);
  });

  it("converts scalar points to seconds and keeps unreadable values as gaps", () => {
    const data = scopeData("scalar", [
      { t: 0, tb: 1_000, v: 1.5 }, { t: 1, tb: 1_500, v: "x" }, { t: 2, tb: 2_000, v: true }
    ]);
    expect(data).toMatchObject({ x: [1, 1.5, 2], ys: [[1.5, null, 1]], stepped: false });
  });

  it("stacks the active bits in lanes and holds the last level to the window edge", () => {
    const data = scopeData("bits", [{ t: 0, tb: 1_000, mask: 0b100 }, { t: 1, tb: 1_100, mask: "1" }], 1_300);
    expect(data.bits).toEqual([0, 2]);
    expect(data.x).toEqual([1, 1.1, 1.3]);
    expect(data.ys).toEqual([[0, 1, 1], [1 + BIT_LANE, BIT_LANE, BIT_LANE]]);
    expect(data.labels).toEqual(["bit 0", "bit 2"]);
  });

  it("renders bytes as escaped text or hex with the direction and note", () => {
    const record = { i: 1, t: 0, tb: 0, dir: "tx" as const, data: "41 0d 0a ff", note: "ping" };
    expect(terminalLine("bytes", record, "text")).toEqual({ tb: 0, dir: "tx", text: "A\\r\\n\\xff  # ping" });
    expect(terminalLine("bytes", record, "hex").text).toBe("41 0d 0a ff  # ping");
    expect(terminalLine("frames", { i: 2, t: 0, tb: 0, id: 0x1a, data: "0102" }, "text").text).toBe("0x1A [2] 01 02");
    expect(terminalLine("events", { i: 3, t: 0, tb: 0, type: "fault", code: 7 }, "text"))
      .toMatchObject({ dir: "event", text: "fault {\"type\":\"fault\",\"code\":7}" });
    expect(ansiLine({ tb: 0, dir: "rx", text: "ok" })).toMatch(/\x1b\[32mRX\x1b\[0m ok$/);
  });

  it("maps verdicts to overlay tones", () => {
    expect(["PASS", "fail", "aborted", "inconclusive", undefined].map(verdictTone))
      .toEqual(["pass", "fail", "fail", "run", "neutral"]);
  });

  it("keeps only the windows and marks of the stream", () => {
    const scope = stream("scope/ch1");
    const overlays = overlaysFor(timeline({
      windows: [
        {
          sequence: 1, stepId: "observe", executionId: "e1", type: "observe", key: "scope/ch1",
          hardwareId: "scope", streamId: "ch1", verdict: "pass", tb0: 1_100, tb1: 1_200
        },
        {
          sequence: 2, stepId: "expect", executionId: "e2", name: "上升沿", type: "expect", key: "scope/ch1",
          hardwareId: "scope", streamId: "ch1", verdict: "fail", tb0: 1_300, tb1: 1_400, matchTb: 1_350
        },
        {
          sequence: 3, stepId: "other", executionId: "e3", type: "observe", key: "dmm/v",
          hardwareId: "dmm", streamId: "v", verdict: "pass", tb0: 1_100, tb1: 1_200
        }
      ],
      anchors: [
        { name: "pulse", hardwareId: "scope", t: 0, tb: 1_050, stepId: "invoke", executionId: "e0" },
        { name: "far", hardwareId: "dmm", t: 0, tb: 1_050, stepId: "invoke", executionId: "e0" }
      ],
      calls: [{
        operationId: "op", executionId: "e0", stepId: "invoke", hardwareId: "scope", toolName: "arm",
        arguments: {}, tb0: 1_000, tb1: null, state: "running"
      }],
      violations: [{ stepId: "guard", key: "scope/ch1", tb: 1_500, onViolation: "abort", violation: {} }]
    }), scope);
    expect(overlays.windows).toEqual([
      { tb0: 1_100, tb1: 1_200, tone: "pass", label: "observe" },
      { tb0: 1_300, tb1: 1_400, tone: "fail", label: "上升沿" }
    ]);
    expect(overlays.marks).toEqual([
      { tb: 1_500, tone: "fail", label: "violation" },
      { tb: 1_350, tone: "fail", label: "上升沿" }
    ]);
  });

  it("finds the innermost step running at an instant", () => {
    const step = (executionId: string, tb0: number, tb1: number | null) => ({
      executionId, stepId: executionId, stepType: "Group", region: "test", tb0, tb1, verdict: null, durationMs: null
    });
    const value = timeline({
      steps: [step("outer", 1_000, 2_000), step("inner", 1_200, 1_300), step("open", 1_800, null)]
    });
    expect(stepAt(value, 1_250)).toBe("inner");
    expect(stepAt(value, 1_500)).toBe("outer");
    expect(stepAt(value, 2_500)).toBe("open");
    expect(stepAt(value, 500)).toBeUndefined();
  });

  it("spans the run with the recorder's pre-roll and tail, and falls back to the stream extents", () => {
    // Level streams replay a value recorded long before the run; that must not stretch the range.
    const streams = [stream("scope/ch1", { first: { t: 0, tb: -60_000 }, last: { t: 0, tb: 2_100 } })];
    expect(runRange(timeline({ streams }))).toEqual([0, 2_500]);
    expect(runRange(timeline({ tb1: null }), 5_000)).toEqual([0, 5_500]);
    expect(runRange(timeline({ tb0: null, tb1: null, streams }))).toEqual([-60_000, 2_100]);
    expect(runRange(timeline({ tb0: null, tb1: null }))).toBeUndefined();
    expect(runRange(undefined)).toBeUndefined();
  });

  it("names devices without their host prefix and card suffix", () => {
    expect(deviceName("advantech.PCI1710L_CARD_1")).toBe("PCI1710L");
    expect(deviceName("CP118U_I")).toBe("CP118U_I");
    expect(shortLabel({ hardwareId: "srv.PCIE6208V_CARD", streamId: "ao0" })).toBe("PCIE6208V/ao0");
  });

  it("formats readings compactly", () => {
    expect([1.23456, 0, 12, -0.5, 2e7, 0.00012, null].map(formatNumber))
      .toEqual(["1.2346", "0", "12", "-0.5", "2.000e+7", "1.200e-4", "—"]);
    expect(pointText("scalar", { t: 0, tb: 0, v: 5.98 })).toBe("5.98");
    expect(pointText("bits", { t: 0, tb: 0, mask: 5 })).toBe("0b101");
    expect(pointText("scalar", undefined)).toBe("—");
  });

  it("aligns series sampled at different instants on one x column", () => {
    expect(alignSeries([{ x: [1, 3], y: [10, 30] }, { x: [2, 3], y: [20, null] }])).toEqual({
      x: [1, 2, 3], ys: [[10, null, 30], [null, 20, null]]
    });
  });

  it("overlays analog channels and holds level channels to the view end", () => {
    const data = analogData([
      { label: "ai0", points: [{ t: 0, tb: 1_000, v: 1 }, { t: 1, tb: 1_500, v: 2 }], level: false, holdUntil: 3_000 },
      { label: "ao0", points: [{ t: 0, tb: 1_000, v: 6 }], level: true, holdUntil: 2_000 }
    ]);
    expect(data.x).toEqual([1, 1.5, 2]);
    expect(data.ys).toEqual([[1, 2, null], [6, null, 6]]);
    expect(data.labels).toEqual(["ai0", "ao0"]);
  });

  it("gives the changing bits of several streams consecutive lanes and lists the steady streams", () => {
    const data = logicData([
      { label: "PCI1730/di", points: [{ t: 0, tb: 1_000, mask: 0b111 }, { t: 1, tb: 2_000, mask: 0b110 }] },
      { label: "PCI1730/do", points: [{ t: 0, tb: 1_000, mask: 0b10 }, { t: 1, tb: 1_500, mask: 0 }] },
      { label: "PCI1730/relay", points: [{ t: 0, tb: 1_000, mask: 0xff }], holdUntil: 3_000 }
    ]);
    expect(data.lanes).toEqual(["PCI1730/di.0", "PCI1730/do.1"]);
    expect(data.owners).toEqual([0, 1]);
    expect(data.x).toEqual([1, 1.5, 2]);
    expect(data.ys).toEqual([[1, null, 0], [BIT_LANE + 1, BIT_LANE, null]]);
    expect(data.steady).toEqual([{ label: "PCI1730/relay", mask: 0xff }]);
    expect(data.stepped).toBe(true);
  });

  it("keeps the lanes a live view asked for even when those bits hold in the window", () => {
    const points = [{ t: 0, tb: 1_000, mask: 0b01 }, { t: 1, tb: 2_000, mask: 0b11 }];
    const steady = [{ t: 0, tb: 1_000, mask: 0b01 }];
    expect(logicData([{ label: "do", points }]).changedBits).toEqual([0b10]);
    const kept = logicData([{ label: "do", points: steady, keepBits: 0b10 }]);
    expect(kept.lanes).toEqual(["do.1"]);
    expect(kept.steady).toEqual([]);
    expect(kept.changedBits).toEqual([0]);
    // A stream without points has no lanes to keep.
    expect(logicData([{ label: "do", points: [], keepBits: 0b10 }]).lanes).toEqual([]);
  });

  it("reads the last point at or before an instant", () => {
    const points = [{ t: 0, tb: 100, v: 1 }, { t: 1, tb: 200, v: 2 }, { t: 2, tb: 300, v: 3 }];
    expect(pointAt(points, 50)).toBeUndefined();
    expect(pointAt(points, 100)?.v).toBe(1);
    expect(pointAt(points, 250)?.v).toBe(2);
    expect(pointAt(points, 900)?.v).toBe(3);
    expect(pointAt([], 100)).toBeUndefined();
  });

  it("picks the streams a run judged or addressed", () => {
    const value = timeline({
      streams: [
        stream("PCI1710L/ai0", { count: 5 }), stream("PCI1710L/ai1", { count: 5 }),
        stream("PCI1730/do", { count: 2 }), stream("PCI1730/di0", { count: 2 }), stream("DMM/v", { count: 0 })
      ],
      windows: [{
        sequence: 1, stepId: "observe", executionId: "e1", type: "observe", key: "DMM/v",
        hardwareId: "DMM", streamId: "v", verdict: "pass", tb0: 1_100, tb1: 1_200
      }],
      calls: [
        { operationId: "a", executionId: "e0", stepId: "s", hardwareId: "PCI1710L", toolName: "read",
          arguments: { channel: "1" }, tb0: 1_000, tb1: 1_010, state: "succeeded" },
        { operationId: "b", executionId: "e0", stepId: "s", hardwareId: "PCI1730", toolName: "write",
          arguments: { port: 5 }, tb0: 1_000, tb1: 1_010, state: "succeeded" }
      ]
    });
    expect([...relevantStreams(value)].sort()).toEqual(["DMM/v", "PCI1710L/ai1", "PCI1730/do"]);
    expect(relevantStreams(undefined).size).toBe(0);
  });

  it("combines the overlays of several streams", () => {
    const value = timeline({
      calls: [{
        operationId: "op", executionId: "e0", stepId: "invoke", hardwareId: "scope", toolName: "arm",
        arguments: {}, tb0: 1_000, tb1: 1_100, state: "succeeded"
      }],
      violations: [{ stepId: "guard", key: "scope/ch2", tb: 1_500, onViolation: "abort", violation: {} }]
    });
    const overlays = combinedOverlays(value, [stream("scope/ch1"), stream("scope/ch2")]);
    expect(overlays.windows).toEqual([]);
    expect(overlays.marks).toEqual([{ tb: 1_500, tone: "fail", label: "violation" }]);
    expect(combinedOverlays(value, [])).toEqual({ windows: [], marks: [] });
  });

  it("merges steps, calls, verdicts and bus traffic into one ordered console", () => {
    const value = timeline({
      steps: [{
        executionId: "e1", stepId: "set", stepType: "Invoke", region: "test", tb0: 1_000, tb1: 1_200,
        verdict: "pass", durationMs: 200
      }],
      calls: [{
        operationId: "op", executionId: "e1", stepId: "set", hardwareId: "srv.PCIE6208V_CARD", toolName: "write_ao",
        arguments: { channel: 0, value: 6 }, tb0: 1_010, tb1: 1_020, state: "failed",
        result: { error: { code: "unavailable", message: "board busy" } }
      }],
      marks: [{ type: "run_started", tb: 1_000 }]
    });
    const bus = recordEntry(
      { key: "CP118U_I/serial1", hardwareId: "CP118U_I", streamId: "serial1", type: "bytes" },
      { i: 1, t: 0, tb: 1_015, dir: "rx", data: "4f4b" }
    );
    const entries = [...timelineEntries(value), bus].sort(compareEntries);
    expect(entries.map((entry) => entry.id)).toEqual([
      "event:run_started:1000:", "step:e1", "call:op", "CP118U_I/serial1:1", "call-end:op", "step-end:e1"
    ]);
    expect(entries.find((entry) => entry.id === "call:op")?.text).toBe("write_ao channel=0 value=6");
    expect(entries.find((entry) => entry.id === "call-end:op")?.text).toBe("write_ao 失败：board busy");
    expect(entries.find((entry) => entry.id === "call:op")?.hardwareId).toBe("srv.PCIE6208V_CARD");
    expect(bus.hardwareId).toBe("CP118U_I");
    expect(entries.find((entry) => entry.id === "step-end:e1")?.text).toBe("set pass · 200 ms");
    const named = timelineEntries(value, new Map([["e1", "设置输出电压"]]));
    expect(named.find((entry) => entry.id === "step:e1")?.text).toBe("设置输出电压 · Invoke · 测试");
    expect(timelineEntries(undefined)).toEqual([]);

    const line = consoleLine(bus, "text", 1_000);
    expect(line).toContain("   +0.015");
    expect(line).toContain("CP118U_I/serial1");
    expect(line).toMatch(/RX\[0m OK$/);
    expect(consoleLine(bus, "hex")).toMatch(/4f 4b$/);
    expect(relativeTime(500, 1_000)).toBe("-0.500");
  });

  it("shows what each device call returned", () => {
    const call = (operationId: string, result: unknown) => ({
      operationId, executionId: "e1", stepId: "read", hardwareId: "PCI1710L", toolName: "read_ai",
      arguments: { channel: 3 }, tb0: 1_000, tb1: 1_050, state: "succeeded", result
    });
    const entries = timelineEntries(timeline({
      calls: [
        call("value", { value: 3.3, unit: "V" }),
        call("scalar", 7),
        call("none", undefined),
        call("bulky", { truncated: true, preview: "x".repeat(2000) })
      ]
    }));
    const reply = (id: string) => entries.find((entry) => entry.id === `call-end:${id}`);
    expect(reply("value")).toMatchObject({ tb: 1_050, tag: "← ", text: 'read_ai value=3.3 unit="V"' });
    expect(reply("scalar")?.text).toBe("read_ai 7");
    expect(reply("none")?.text).toBe("read_ai 完成");
    expect(reply("bulky")?.text).toHaveLength("read_ai ".length + 200);
  });

  it("reads volts off analog channel ids only", () => {
    expect(streamUnit({ streamId: "ai3", type: "scalar" })).toBe("V");
    expect(streamUnit({ streamId: "AO0", type: "block" })).toBe("V");
    expect(streamUnit({ streamId: "di", type: "bits" })).toBe("");
    expect(streamUnit({ streamId: "temp", type: "scalar" })).toBe("");
    const derived = { alias: "dut", icd: "dut_cmd", icdHash: "h", source: "dev__rx", message: "status", field: "v" };
    expect(streamUnit({ streamId: "dut.status.v", type: "scalar", derived: { ...derived, unit: "V" } })).toBe("V");
    expect(streamUnit({ streamId: "ai0", type: "scalar", derived })).toBe("");
  });
});
