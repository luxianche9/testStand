// @vitest-environment jsdom
import type { LiveFrame, LiveQuery } from "@teststand/contracts/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveHub } from "./live-hub.js";

function frame(keys: string[]): LiveFrame {
  return { t: 1, colMs: 10, streams: Object.fromEntries(keys.map((key) => [key, { key } as never])) };
}

describe("live hub", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shares one subscription and restarts it when a consumer joins", () => {
    const stops: ReturnType<typeof vi.fn>[] = [];
    const calls: { query: LiveQuery; onFrame: (frame: LiveFrame) => void }[] = [];
    const upstream = vi.fn((query: LiveQuery, onFrame: (frame: LiveFrame) => void) => {
      calls.push({ query, onFrame });
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    });
    const hub = createLiveHub(upstream);
    const a = vi.fn();
    const aGap = vi.fn();
    const stopA = hub({ keys: ["H__ai0"], width: 100, windowMs: 2000 }, a, aGap);
    vi.advanceTimersByTime(50);
    expect(upstream).toHaveBeenCalledTimes(1);
    calls[0]!.onFrame(frame(["H__ai0", "H__di"]));
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ streams: { H__ai0: { key: "H__ai0" } } }));

    const b = vi.fn();
    hub({ keys: ["H__di"], width: 400, windowMs: 60000 }, b);
    vi.advanceTimersByTime(50);
    expect(stops[0]).toHaveBeenCalled();
    expect(aGap).toHaveBeenCalledTimes(1);
    expect(calls[1]!.query).toEqual({ keys: ["H__ai0", "H__di"], width: 400, windowMs: 60000 });
    calls[1]!.onFrame(frame(["H__di"]));
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1);

    stopA();
    vi.advanceTimersByTime(50);
    expect(upstream).toHaveBeenCalledTimes(2);
    hub.close();
    expect(stops[1]).toHaveBeenCalled();
  });
});
