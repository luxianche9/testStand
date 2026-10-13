import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTSTAND_EVENT_NAMES, type TestStandEventName } from "@teststand/contracts/desktop";
import { eventInvalidations, subscribeInvalidations } from "./event-invalidation.js";
import { queryKeys } from "./query-keys.js";

function fakeEvents() {
  const listeners = new Map<string, () => void>();
  return {
    subscribe: vi.fn((event: TestStandEventName, listener: () => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    }),
    emit: (event: TestStandEventName) => listeners.get(event)?.(),
    listeners
  };
}

describe("event invalidation table", () => {
  afterEach(() => vi.useRealTimers());

  it("maps every event the contracts declare, and nothing else", () => {
    expect(Object.keys(eventInvalidations).sort()).toEqual([...TESTSTAND_EVENT_NAMES].sort());
  });

  it("invalidates at once, coalesces delayed keys and refetches everything after a gap", () => {
    vi.useFakeTimers();
    const events = fakeEvents();
    const invalidate = vi.fn();
    const stop = subscribeInvalidations(events.subscribe, invalidate);
    expect(events.listeners.has("window-state")).toBe(false);

    events.emit("testRun");
    events.emit("testRun");
    expect(invalidate).not.toHaveBeenCalledWith(queryKeys.testRun);
    vi.advanceTimersByTime(100);
    expect(invalidate).toHaveBeenCalledWith(queryKeys.testRun);
    expect(invalidate).not.toHaveBeenCalledWith(queryKeys.testRunsAll);
    vi.advanceTimersByTime(500);
    expect(invalidate.mock.calls.filter(([key]) => key === queryKeys.testRunsAll)).toHaveLength(1);

    events.emit("gap");
    expect(invalidate).toHaveBeenLastCalledWith("all");

    events.emit("wiringTask");
    stop();
    vi.advanceTimersByTime(100);
    expect(invalidate).not.toHaveBeenCalledWith(queryKeys.wiringTasks);
    expect(events.listeners.size).toBe(0);
  });
});
