import type { QueryKey } from "@tanstack/react-query";
import type { HardwareHarnessEventName } from "@hardwareharness/contracts/desktop";
import { queryKeys } from "./query-keys.js";

/**
 * One query family an event makes stale. `delayMs` coalesces bursts: run events arrive per log line, wiring
 * tasks per operation, and the lists behind them only need one refresh.
 */
export interface Invalidation {
  key: QueryKey | "all";
  delayMs?: number;
}

/**
 * Event → stale queries (design §9.6.3). Events carry only the changed resource's key and version, so the
 * interface never copies data out of them; it refetches. A new event type must be added here (the coverage
 * test fails otherwise). Pages that follow one resource closely (plan editor, run log) additionally compare
 * the version in the event with what they hold.
 */
export const eventInvalidations: Record<HardwareHarnessEventName, readonly Invalidation[]> = {
  // The backend's periodic device check saw a device change state.
  availability: [{ key: queryKeys.dashboard }, { key: queryKeys.agentTools }],
  // A catalog write: hardware, device instances, adapter records or a device's cached declaration.
  devices: [
    { key: queryKeys.deviceCatalog },
    { key: queryKeys.dashboard },
    { key: queryKeys.deviceDefinitionAll },
    { key: queryKeys.adapterStatusAll },
    { key: queryKeys.deviceStreamsAll },
    { key: queryKeys.testDeviceToolsAll },
    { key: queryKeys.agentTools }
  ],
  // The MCP gateway's token, client or tools changed.
  gateway: [{ key: queryKeys.dashboard }, { key: queryKeys.agentTools }, { key: queryKeys.agentIntegrationAll }],
  execution: [{ key: queryKeys.dashboard }],
  project: [
    { key: queryKeys.projectDocument },
    { key: queryKeys.wiringTasks },
    // Canvas edits are logged by the backend as they are applied.
    { key: queryKeys.wiringChanges }
  ],
  wiringTask: [{ key: queryKeys.wiringTasks, delayMs: 100 }, { key: queryKeys.projectDocument, delayMs: 100 }],
  testPlan: [{ key: queryKeys.testPlans }, { key: queryKeys.testItemStatus }],
  testRun: [
    { key: queryKeys.testRun },
    { key: queryKeys.dashboard },
    { key: queryKeys.testItemStatus },
    { key: queryKeys.testRunsAll, delayMs: 500 },
    { key: queryKeys.testRecovery, delayMs: 500 }
  ],
  testBatch: [{ key: queryKeys.testBatch }, { key: queryKeys.testItemStatus }],
  // An Agent's high-risk operation started or stopped waiting for the operator.
  confirmation: [{ key: queryKeys.agentConfirmations }],
  opencode: [{ key: queryKeys.openCodeStatus }],
  // Main-process window state; the title bar follows it directly, no server data changed.
  "window-state": [],
  // The event stream lost events (reconnect, backend restart): refetch everything.
  gap: [{ key: "all" }]
};

/** Subscribe `invalidate` to every event per the table; returns the unsubscribe. */
export function subscribeInvalidations(
  subscribe: (event: HardwareHarnessEventName, listener: () => void) => () => void,
  invalidate: (key: QueryKey | "all") => void,
  table: Record<HardwareHarnessEventName, readonly Invalidation[]> = eventInvalidations
): () => void {
  const pending = new Map<number, Set<QueryKey | "all">>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const later = (delayMs: number, key: QueryKey | "all") => {
    const keys = pending.get(delayMs) ?? new Set();
    keys.add(key);
    pending.set(delayMs, keys);
    clearTimeout(timers.get(delayMs));
    timers.set(delayMs, setTimeout(() => {
      timers.delete(delayMs);
      pending.delete(delayMs);
      for (const item of keys) invalidate(item);
    }, delayMs));
  };
  const stops = (Object.keys(table) as HardwareHarnessEventName[])
    .filter((event) => table[event].length > 0)
    .map((event) => subscribe(event, () => {
      for (const { key, delayMs } of table[event]) {
        if (delayMs) later(delayMs, key);
        else invalidate(key);
      }
    }));
  return () => {
    for (const stop of stops) stop();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    pending.clear();
  };
}
