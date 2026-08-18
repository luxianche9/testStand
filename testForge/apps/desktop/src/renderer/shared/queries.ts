import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "./query-keys.js";

/**
 * Queries shared by more than one page. Keeping them here means a page cannot silently disagree
 * with another about how often a key refetches — which is exactly what happened when the device
 * catalog and dashboard queries were each declared twice with drifting options.
 */

/** The catalog also changes from outside the UI (a bundle import, another window), and it has no
 *  event channel, so it is polled rather than left stale. */
export function useDeviceCatalog() {
  return useQuery({
    queryKey: queryKeys.deviceCatalog,
    queryFn: async () => ({ hardware: await window.testforge.devices.listHardware() }),
    refetchInterval: 10_000
  });
}

/** Remote availability is pushed on the `availability` channel; this poll is the dropped-event
 *  fallback described in docs/architecture.md. */
export function useDashboard() {
  return useQuery({ queryKey: queryKeys.dashboard, queryFn: () => window.testforge.system.dashboard(), refetchInterval: 10_000 });
}

/** Main-process project document buffer: path, dirty flag, and the single file contents. */
export function useProjectDocument() {
  return useQuery({ queryKey: queryKeys.projectDocument, queryFn: () => window.testforge.projects.current() });
}

export function useRecentProjects() {
  return useQuery({ queryKey: queryKeys.recentProjects, queryFn: () => window.testforge.projects.listRecent() });
}

/** AI 发起的人工接线任务（含调用历史）。刷新由 AppShell 的 wiringTask/project 订阅驱动。 */
export function useWiringTasks() {
  return useQuery({ queryKey: queryKeys.wiringTasks, queryFn: () => window.testforge.wiring.listTasks({ limit: 200 }) });
}

/** Session-scoped AI requests for a human to occupy one or more hardware devices. */
export function useOccupancyRequests() {
  return useQuery({ queryKey: queryKeys.occupancyRequests, queryFn: () => window.testforge.occupancy.listRequests({ limit: 200 }) });
}
