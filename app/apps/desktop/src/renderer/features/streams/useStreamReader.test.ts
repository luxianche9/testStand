import { describe, expect, it } from "vitest";
import type { LiveFrame, LiveStreamEntry, StreamWindow } from "@teststand/contracts/observability";
import { mergeFrame, trimBuffers } from "./useStreamReader.js";

function entry(overrides: Partial<LiveStreamEntry>): LiveStreamEntry {
  return {
    key: "H__ai0", type: "analog", t0: 0, t1: null, colMs: 10, watermarkTb: 100, lastI: 1, gaps: [],
    state: null, ...overrides
  };
}

function frame(streams: Record<string, LiveStreamEntry>): LiveFrame {
  return { t: 1_000, colMs: 10, streams };
}

const point = (tb: number, v = tb) => ({ t: tb, tb, v });

describe("live frames", () => {
  it("replaces the points from the entry's first column on and keeps those before it", () => {
    const first = mergeFrame({}, frame({ H__ai0: entry({ reset: true, points: [point(0), point(10), point(20)] }) }));
    const next = mergeFrame(first, frame({ H__ai0: entry({ t0: 10, points: [point(10, 5), point(30)] }) }));
    expect(next.H__ai0?.points).toEqual([point(0), point(10, 5), point(30)]);
  });

  it("drops the old points on reset and only updates the meta without points", () => {
    const first = mergeFrame({}, frame({ H__ai0: entry({ reset: true, points: [point(0)] }) }));
    const reset = mergeFrame(first, frame({ H__ai0: entry({ reset: true, t0: 50, points: [point(50)] }) }));
    expect(reset.H__ai0?.points).toEqual([point(50)]);
    const meta = mergeFrame(reset, frame({ H__ai0: entry({ t0: 60, watermarkTb: 200 }) }));
    expect(meta.H__ai0?.points).toEqual([point(50)]);
    expect(meta.H__ai0?.watermarkTb).toBe(200);
  });

  it("leaves record entries to the terminals", () => {
    const next = mergeFrame({}, frame({ H__uart: entry({ key: "H__uart", type: "bytes", records: [] }) }));
    expect(next).toEqual({});
  });

  it("trims to the cutoff but keeps the value in force there", () => {
    const buffers: Record<string, StreamWindow> = {
      H__ai0: entry({ points: [point(0), point(10), point(20), point(30)] })
    };
    expect(trimBuffers(buffers, 25).H__ai0?.points).toEqual([point(20), point(30)]);
    expect(trimBuffers(buffers, 99).H__ai0?.points).toEqual([point(30)]);
    expect(trimBuffers(buffers, 0)).toEqual(buffers);
  });
});
