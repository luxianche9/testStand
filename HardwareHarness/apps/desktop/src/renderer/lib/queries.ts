import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { AgentKind } from "@hardwareharness/contracts/agents";
import type { TestRunListInput } from "@hardwareharness/contracts/testing";
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
    queryFn: async () => ({ hardware: await window.hardwareharness.devices.listHardware() }),
    refetchInterval: 10_000
  });
}

/** Remote availability is pushed on the `availability` channel; this poll is the dropped-event
 *  fallback described in docs/architecture.md. */
export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => window.hardwareharness.system.dashboard(),
    refetchInterval: 10_000
  });
}

/** Main-process project document buffer: path, dirty flag, and the single file contents. */
export function useProjectDocument() {
  return useQuery({ queryKey: queryKeys.projectDocument, queryFn: () => window.hardwareharness.projects.current() });
}

export function useRecentProjects() {
  return useQuery({ queryKey: queryKeys.recentProjects, queryFn: () => window.hardwareharness.projects.listRecent() });
}

/** AI 发起的人工接线任务（含调用历史）。刷新由 wiringTask/project 事件驱动（lib/event-invalidation.ts）。 */
export function useWiringTasks() {
  return useQuery({
    queryKey: queryKeys.wiringTasks,
    queryFn: () => window.hardwareharness.wiring.listTasks({ limit: 500 })
  });
}

/** 工位接线的人工更改日志（持久化在项目运行库中）。刷新由 project 事件驱动。 */
export function useWiringChanges() {
  return useQuery({
    queryKey: queryKeys.wiringChanges,
    queryFn: () => window.hardwareharness.wiring.listChanges({ limit: 500 })
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
    queryFn: () => window.hardwareharness.testing.listRuns(filters),
    enabled
  });
}

export function useTestDeviceTools(hardwareId: string) {
  return useQuery({
    queryKey: queryKeys.testDeviceTools(hardwareId),
    queryFn: () => window.hardwareharness.testing.listDeviceTools(hardwareId),
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
 *  refreshes it on every server refresh, so this only has to follow that cadence. */
export function useDeviceDefinition(hardwareId: string) {
  return useQuery({
    queryKey: queryKeys.deviceDefinition(hardwareId),
    queryFn: () => window.hardwareharness.devices.getDefinition(hardwareId),
    refetchInterval: 15_000
  });
}

/** The adapter's release record (design doc §8.4); it only changes through this UI or the Agent. */
export function useAdapterStatus(hardwareId: string) {
  return useQuery({
    queryKey: queryKeys.adapterStatus(hardwareId),
    queryFn: () => window.hardwareharness.devices.getAdapterStatus(hardwareId),
    refetchInterval: 15_000
  });
}

/** Who holds the device's lease; asked of the service, so only while it is reachable. */
export function useDeviceLease(hardwareId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.deviceLease(hardwareId),
    queryFn: () => window.hardwareharness.streams.leaseStatus(hardwareId),
    enabled,
    refetchInterval: 5_000
  });
}

type ImageRef = { hardwareId: string; assetId?: string | undefined };
const imageData = (results: Array<{ data?: string | undefined }>) => results.map((result) => result.data);

/** Resolved `hardwareharness-asset:` URLs for stored photos, keyed `${hardwareId}:${assetId}`.
 *  assetIds are only unique per device, so the key carries the owner. Shares the cache with
 *  HardwareImage through `queryKeys.hardwareImage`. */
export function useHardwareImageUrls(items: readonly ImageRef[]): Record<string, string> {
  const refs = useMemo(
    () => items.flatMap((item) => item.assetId ? [{ hardwareId: item.hardwareId, assetId: item.assetId }] : []),
    [items]
  );
  const urls = useQueries({
    queries: refs.map((ref) => ({
      queryKey: queryKeys.hardwareImage(ref.hardwareId, ref.assetId),
      queryFn: () => window.hardwareharness.devices.hardwareImageUrl(ref.hardwareId, ref.assetId),
      staleTime: Infinity
    })),
    combine: imageData
  });
  return useMemo(() => Object.fromEntries(refs.flatMap((ref, index) => {
    const url = urls[index];
    return url ? [[`${ref.hardwareId}:${ref.assetId}`, url]] : [];
  })), [refs, urls]);
}

/** Embedded OpenCode runtime. Pushed on the `opencode` channel; the poll covers dropped events. */
export function useOpenCodeStatus() {
  return useQuery({
    queryKey: queryKeys.openCodeStatus,
    queryFn: () => window.hardwareharness.agents.openCodeStatus(),
    refetchInterval: 5_000
  });
}

/** OpenAI-compatible model settings (the API key itself never reaches the renderer). */
export function useLlmSettings() {
  return useQuery({ queryKey: queryKeys.llmSettings, queryFn: () => window.hardwareharness.settings.getLlm() });
}

/** External agent (Codex) integration state; config files change outside the app, so it is polled. */
export function useAgentIntegration(agent: AgentKind) {
  return useQuery({
    queryKey: queryKeys.agentIntegration(agent),
    queryFn: () => window.hardwareharness.agents.status(agent),
    refetchInterval: 15_000
  });
}

/** Tools the MCP gateway exposes (builtin + remote servers). */
export function useAgentTools() {
  return useQuery({
    queryKey: queryKeys.agentTools,
    queryFn: () => window.hardwareharness.agents.listTools(),
    refetchInterval: 10_000
  });
}
