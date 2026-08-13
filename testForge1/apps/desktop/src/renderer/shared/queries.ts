import { useQuery } from "@tanstack/react-query";

/**
 * Queries shared by more than one page. Keeping them here means a page cannot silently disagree
 * with another about how often a key refetches — which is exactly what happened when the device
 * catalog and dashboard queries were each declared twice with drifting options.
 */

/** The catalog also changes from outside the UI (a bundle import, another window), and it has no
 *  event channel, so it is polled rather than left stale. */
export function useDeviceCatalog() {
  return useQuery({
    queryKey: ["device-catalog"],
    queryFn: async () => ({ hardware: await window.testforge.devices.listHardware() }),
    refetchInterval: 10_000
  });
}

/** Remote availability is pushed on the `availability` channel; this poll is the dropped-event
 *  fallback described in docs/architecture.md. */
export function useDashboard() {
  return useQuery({ queryKey: ["dashboard"], queryFn: () => window.testforge.system.dashboard(), refetchInterval: 10_000 });
}

/** Main-process project document buffer: path, dirty flag, and the single file contents. */
export function useProjectDocument() {
  return useQuery({ queryKey: ["project-document"], queryFn: () => window.testforge.projects.current() });
}

export function useRecentProjects() {
  return useQuery({ queryKey: ["recent-projects"], queryFn: () => window.testforge.projects.listRecent() });
}

/** AI 发起的人工接线任务（含调用历史）。刷新由 AppShell 的 wiringTask/project 订阅驱动。 */
export function useWiringTasks() {
  return useQuery({ queryKey: ["wiring-tasks"], queryFn: () => window.testforge.wiring.listTasks({ limit: 200 }) });
}
