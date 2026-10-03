import { useQuery } from "@tanstack/react-query";
import type { AgentKind } from "@hardwareharness/contracts/agents";
import type { TestRunListInput } from "@hardwareharness/contracts/testing";
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
    queryFn: async () => ({ hardware: await window.hardwareharness.devices.listHardware() })
  });
}

/** Refetched on `availability`, `devices`, `gateway`, `execution` and `testRun` events. */
export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => window.hardwareharness.system.dashboard()
  });
}

/** The open project document: path, dirty flag, and the single file contents. */
export function useProjectDocument() {
  return useQuery({ queryKey: queryKeys.projectDocument, queryFn: () => window.hardwareharness.projects.document() });
}

export function useRecentProjects() {
  return useQuery({ queryKey: queryKeys.recentProjects, queryFn: () => window.hardwareharness.projects.listRecent() });
}

/** AI 发起的人工接线任务（含调用历史）。刷新由 wiringTask/project 事件驱动（lib/event-invalidation.ts）。 */
export function useWiringTasks() {
  return useQuery({
    queryKey: queryKeys.wiringTasks,
    queryFn: () => window.hardwareharness.wiring.listTasks({ input: { limit: 500 } })
  });
}

/** 工位接线的人工更改日志（持久化在项目运行库中）。刷新由 project 事件驱动。 */
export function useWiringChanges() {
  return useQuery({
    queryKey: queryKeys.wiringChanges,
    queryFn: () => window.hardwareharness.wiring.listChanges({ input: { limit: 500 } })
  });
}

/** 功能测试项（已保存的测试计划）。刷新由 testPlan 事件驱动。 */
function useTestPlans() {
  return useQuery({ queryKey: queryKeys.testPlans, queryFn: () => window.hardwareharness.testing.listPlans() });
}

export function useTestStepCatalog() {
  return useQuery({
    queryKey: queryKeys.testStepCatalog,
    queryFn: () => window.hardwareharness.testing.listStepCatalog(),
    staleTime: Infinity
  });
}

/** Refetched on `testRun` events; a dropped event arrives as `gap`, which refetches everything. */
export function useCurrentTestRun() {
  return useQuery({ queryKey: queryKeys.testRun, queryFn: () => window.hardwareharness.testing.currentRun() });
}

/** Current unit + per-item latest result + active batch. Refetched on testPlan/testRun/testBatch events. */
export function useTestItemStatus() {
  return useQuery({
    queryKey: queryKeys.testItemStatus,
    queryFn: () => window.hardwareharness.testing.listItemStatus()
  });
}

export function useTestRuns(filters: TestRunListInput, enabled = true) {
  return useQuery({
    queryKey: queryKeys.testRuns(filters),
    queryFn: () => window.hardwareharness.testing.listRuns({ input: filters }),
    enabled
  });
}

export function useTestDeviceTools(hardwareId: string) {
  return useQuery({
    queryKey: queryKeys.testDeviceTools(hardwareId),
    queryFn: () => window.hardwareharness.testing.listDeviceTools({ hardwareId }),
    enabled: Boolean(hardwareId)
  });
}

/** Operations whose physical outcome is unknown and need a human reconcile. */
export function useTestRecoveryItems() {
  return useQuery({
    queryKey: queryKeys.testRecovery,
    queryFn: () => window.hardwareharness.testing.listRecoveryItems()
  });
}

/** A managed device's own declaration (`/device`), as the backend last cached it. The backend
 *  stores a new revision when it refreshes the device, which publishes `devices`. */
export function useDeviceDefinition(hardwareId: string) {
  return useQuery({
    queryKey: queryKeys.deviceDefinition(hardwareId),
    queryFn: () => window.hardwareharness.devices.getDefinition({ hardwareId })
  });
}

/** The adapter's release record (design doc §8.4); every change is a catalog write (`devices`). */
export function useAdapterStatus(hardwareId: string) {
  return useQuery({
    queryKey: queryKeys.adapterStatus(hardwareId),
    queryFn: () => window.hardwareharness.devices.getAdapterStatus({ hardwareId })
  });
}

/** Embedded OpenCode runtime, which the backend runs; refetched on `opencode` events. */
export function useOpenCodeStatus() {
  return useQuery({
    queryKey: queryKeys.openCodeStatus,
    queryFn: () => window.hardwareharness.agents.openCodeStatus()
  });
}

/** OpenAI-compatible model settings (the API key itself never reaches the renderer). */
export function useLlmSettings() {
  return useQuery({ queryKey: queryKeys.llmSettings, queryFn: () => window.hardwareharness.settings.getLlm() });
}

/** External agent (Codex) integration state. The one poll left: Codex's config.toml and the user
 *  environment change outside HardwareHarness (the Codex CLI, another program), so no backend
 *  event can announce them. Gateway changes still refetch at once (`gateway`). */
export function useAgentIntegration(agent: AgentKind) {
  return useQuery({
    queryKey: queryKeys.agentIntegration(agent),
    queryFn: () => window.hardwareharness.agents.status({ agent }),
    refetchInterval: 15_000
  });
}

/** Tools the MCP gateway exposes (builtin + device tools); refetched on `devices`, `availability`
 *  and `gateway` events. */
export function useAgentTools() {
  return useQuery({
    queryKey: queryKeys.agentTools,
    queryFn: () => window.hardwareharness.agents.listTools()
  });
}
