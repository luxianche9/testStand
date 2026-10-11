import { useQuery } from "@tanstack/react-query";
import type { AgentKind } from "@teststand/contracts/agents";
import type { TestRunListInput } from "@teststand/contracts/testing";
import { queryKeys } from "./query-keys.js";

/**
 * Queries shared by more than one page. Keeping them here means a page cannot silently disagree
 * with another about how a key refetches. Backend changes arrive as SSE events and invalidate the
 * matching keys (lib/event-invalidation.ts); a dropped event arrives as `gap`, which refetches
 * everything, so nothing here polls unless the data changes outside the backend.
 */

/** Refetched on `devices` events (every catalog write, from the UI or the Agent). */
export function useDeviceCatalog() {
  return useQuery({
    queryKey: queryKeys.deviceCatalog,
    queryFn: async () => ({ hardware: await window.teststand.devices.listHardware() })
  });
}

/** Every device with the streams it declares; refetched on `devices` and `availability` events. */
export function useMonitorStreams() {
  return useQuery({ queryKey: queryKeys.monitorStreams, queryFn: () => window.teststand.monitor.streams() });
}

/** Refetched on `availability`, `devices`, `gateway`, `execution` and `testRun` events. */
export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => window.teststand.system.dashboard()
  });
}

/** Installed device packages; `restartRequired` when an update waits for a restart. */
export function useDevicePackages() {
  return useQuery({
    queryKey: queryKeys.devicePackages,
    queryFn: () => window.teststand.devices.listPackages()
  });
}

/** The open project document: path, dirty flag, and the single file contents. */
export function useProjectDocument() {
  return useQuery({ queryKey: queryKeys.projectDocument, queryFn: () => window.teststand.projects.document() });
}

export function useRecentProjects() {
  return useQuery({ queryKey: queryKeys.recentProjects, queryFn: () => window.teststand.projects.listRecent() });
}

/** AI 发起的人工接线任务（含调用历史）。刷新由 wiringTask/project 事件驱动（lib/event-invalidation.ts）。 */
export function useWiringTasks() {
  return useQuery({
    queryKey: queryKeys.wiringTasks,
    queryFn: () => window.teststand.wiring.listTasks({ input: { limit: 500 } })
  });
}

/** 测试台架接线的人工更改日志（持久化在项目运行库中）。刷新由 project 事件驱动。 */
export function useWiringChanges() {
  return useQuery({
    queryKey: queryKeys.wiringChanges,
    queryFn: () => window.teststand.wiring.listChanges({ input: { limit: 500 } })
  });
}

export function useTestStepCatalog() {
  return useQuery({
    queryKey: queryKeys.testStepCatalog,
    queryFn: () => window.teststand.testing.listStepCatalog(),
    staleTime: Infinity
  });
}

/** Refetched on `testRun` events; a dropped event arrives as `gap`, which refetches everything. */
export function useCurrentTestRun() {
  return useQuery({ queryKey: queryKeys.testRun, queryFn: () => window.teststand.testing.currentRun() });
}

export function useTestRuns(filters: TestRunListInput, enabled = true) {
  return useQuery({
    queryKey: queryKeys.testRuns(filters),
    queryFn: () => window.teststand.testing.listRuns({ input: filters }),
    enabled
  });
}

export function useTestDeviceTools(hardwareId: string) {
  return useQuery({
    queryKey: queryKeys.testDeviceTools(hardwareId),
    queryFn: () => window.teststand.testing.listDeviceTools({ hardwareId }),
    enabled: Boolean(hardwareId)
  });
}

/** Operations whose physical outcome is unknown and need a human reconcile. */
export function useTestRecoveryItems() {
  return useQuery({
    queryKey: queryKeys.testRecovery,
    queryFn: () => window.teststand.testing.listRecoveryItems()
  });
}

/** A managed device's own declaration (`/device`), as the backend last cached it. The backend
 *  stores a new revision when it refreshes the device, which publishes `devices`. */
export function useDeviceDefinition(hardwareId: string) {
  return useQuery({
    queryKey: queryKeys.deviceDefinition(hardwareId),
    queryFn: () => window.teststand.devices.getDefinition({ hardwareId })
  });
}

/** The adapter's release record (design doc §8.4); every change is a catalog write (`devices`). */
/** Embedded OpenCode runtime, which the backend runs; refetched on `opencode` events. */
export function useOpenCodeStatus() {
  return useQuery({
    queryKey: queryKeys.openCodeStatus,
    queryFn: () => window.teststand.agents.openCodeStatus()
  });
}

/** OpenAI-compatible model settings (the API key itself never reaches the renderer). */
export function useLlmSettings() {
  return useQuery({ queryKey: queryKeys.llmSettings, queryFn: () => window.teststand.settings.getLlm() });
}

/** External agent (Codex) integration state. The one poll left: Codex's config.toml and the user
 *  environment change outside testStand (the Codex CLI, another program), so no backend
 *  event can announce them. Gateway changes still refetch at once (`gateway`). */
export function useAgentIntegration(agent: AgentKind) {
  return useQuery({
    queryKey: queryKeys.agentIntegration(agent),
    queryFn: () => window.teststand.agents.status({ agent }),
    refetchInterval: 15_000
  });
}

/** Tools the MCP gateway exposes (builtin + device tools); refetched on `devices`, `availability`
 *  and `gateway` events. */
export function useAgentTools() {
  return useQuery({
    queryKey: queryKeys.agentTools,
    queryFn: () => window.teststand.agents.listTools()
  });
}
