import { describe, expect, it } from "vitest";
import type { RunTimeline, StreamInfo } from "@teststand/contracts/observability";
import { defaultDisplay } from "./channel-display.js";
import {
  BIT_LANE, bitsWidth, codeText, compareEntries, consoleLine, logicData, maskBits, stepDepths, timelineEntries,
  type ConsoleEntry
} from "./stream-model.js";

const point = (tb: number, mask: number) => ({ t: tb, tb, mask });

describe("digital channel display", () => {
  it("formats a mask as a code with the declared name", () => {
    expect(codeText(4, 16)).toEqual({ hex: "0x0004", dec: "4", bin: "0000 0000 0000 0100", short: "0x0004" });
    expect(codeText(1, 8, { 1: "RUN" })).toMatchObject({ hex: "0x01", name: "RUN", short: "RUN" });
    expect(maskBits(0b101, 4)).toEqual([true, false, true, false]);
    expect(bitsWidth({ declaration: { width: 16 } }, [])).toBe(16);
    expect(bitsWidth({}, [point(0, 0x100)])).toBe(9);
  });

  it("draws a bus channel as one lane of held values and names bit lanes by the plugin", () => {
    const data = logicData([
      { label: "PLC/state", points: [point(0, 1), point(10, 1), point(20, 2)], holdUntil: 30, mode: "bus",
        codeLabels: { 1: "RUN" } },
      { label: "RELAY/relay", points: [point(0, 0), point(15, 4)], holdUntil: 30, bitLabels: ["R0", "R1", "R2"] }
    ]);
    expect(data.lanes).toEqual(["PLC/state", "RELAY/relay.R2"]);
    expect(data.buses).toEqual([{ lane: 0, segments: [
      { tb0: 0, tb1: 20, mask: 1, text: "RUN" },
      { tb0: 20, tb1: 30, mask: 2, text: "0x2" }
    ] }]);
    expect(data.ys[0]?.every((value) => value === null)).toBe(true);
    expect(Math.max(...(data.ys[1]?.filter((value): value is number => value !== null) ?? []))).toBe(1 + BIT_LANE);
  });

  it("takes the plugin's suggestion for how a bits stream reads", () => {
    expect(defaultDisplay({ declaration: { display: "switches" } })).toEqual({ trace: "logic" });
    expect(defaultDisplay({ declaration: { display: "code" } })).toEqual({ trace: "bus" });
    expect(defaultDisplay({ declaration: { bitLabels: ["DI0"] } })).toEqual({ trace: "logic" });
    expect(defaultDisplay({} as Pick<StreamInfo, "declaration">)).toEqual({ trace: "bus" });
  });
});

describe("run console nesting", () => {
  const timeline: RunTimeline = {
    runId: "run", tb0: 0, tb1: 100, anchors: [], windows: [], violations: [], marks: [], streams: [], gaps: [],
    steps: [
      { executionId: "g", stepId: "group", stepType: "Group", region: "test", tb0: 0, tb1: 100, verdict: "Pass",
        durationMs: 100 },
      { executionId: "m", stepId: "measure", stepType: "InvokeTool", region: "test", parentExecutionId: "g",
        tb0: 10, tb1: 20, verdict: "Pass", durationMs: 10 }
    ],
    calls: [{ operationId: "op", executionId: "m", stepId: "measure", hardwareId: "DAQ", toolName: "read",
      arguments: {}, tb0: 12, tb1: 18, state: "succeeded", result: { v: 1 } }]
  };

  it("indents steps and their calls under their parent step", () => {
    expect(stepDepths(timeline)).toEqual(new Map([["g", 0], ["m", 1]]));
    const entries = timelineEntries(timeline);
    const depth = (id: string) => entries.find((entry) => entry.id === id)?.depth;
    expect([depth("step:g"), depth("step:m"), depth("call:op"), depth("call-end:op")]).toEqual([0, 1, 2, 2]);
    expect(consoleLine(entries.find((entry) => entry.id === "call:op")!, "text", 0)).toContain("    \x1b[34m→ ");
  });

});
