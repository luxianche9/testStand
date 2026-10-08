import type { QueryKey } from "@tanstack/react-query";
import type { TestStandEventName } from "@teststand/contracts/desktop";
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
export const eventInvalidations: Record<TestStandEventName, readonly Invalidation[]> = {
  // The backend's periodic device check saw a device change state.
  // A device that came online may have declared its streams for the first time.
  availability: [{ key: queryKeys.dashboard }, { key: queryKeys.agentTools }, { key: queryKeys.monitorStreams }],
  // A catalog write: hardware, device instances, adapter records, a device's cached declaration,
  // or an installed device package.
  devices: [
    { key: queryKeys.deviceTypes },
    { key: queryKeys.devicePackages },
    { key: queryKeys.deviceCatalog },
    { key: queryKeys.monitorStreams },
    { key: queryKeys.dashboard },
    { key: queryKeys.deviceDefinitionAll },
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
    // Pin list edits are logged by the backend as they are applied.
    { key: queryKeys.wiringChanges }
  ],
  wiringTask: [{ key: queryKeys.wiringTasks, delayMs: 100 }, { key: queryKeys.projectDocument, delayMs: 100 }],
  // The test panel's editor reloads the flow itself; no query holds it.
  testPlan: [],
  testRun: [
    { key: queryKeys.testRun },
    { key: queryKeys.dashboard },
    { key: queryKeys.testRunsAll, delayMs: 500 },
    { key: queryKeys.testRecovery, delayMs: 500 }
  ],
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
  subscribe: (event: TestStandEventName, listener: () => void) => () => void,
  invalidate: (key: QueryKey | "all") => void,
  table: Record<TestStandEventName, readonly Invalidation[]> = eventInvalidations
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
  const stops = (Object.keys(table) as TestStandEventName[])
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
