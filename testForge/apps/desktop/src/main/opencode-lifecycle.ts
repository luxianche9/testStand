import type { OpenCodeRuntimeStatus } from "@testforge/contracts/agents";

export interface OpenCodeLifecycleRuntime {
  status(): Pick<OpenCodeRuntimeStatus, "state">;
  start(): Promise<unknown>;
  restart(): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface OpenCodeSettingsSnapshot {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
}

export type OpenCodeLifecycleAction = "none" | "start" | "restart" | "stop";

export async function autoStartOpenCode(
  runtime: OpenCodeLifecycleRuntime,
  apiKey: string | undefined,
  hasProject = true
): Promise<OpenCodeLifecycleAction> {
  if (!apiKey?.trim() || !hasProject) return "none";
  await runtime.start();
  return "start";
}

export async function reconcileOpenCodeWorkspace(
  runtime: OpenCodeLifecycleRuntime,
  hasProject: boolean,
  apiKey: string | undefined
): Promise<OpenCodeLifecycleAction> {
  const state = runtime.status().state;
  if (!hasProject) {
    if (state !== "stopped") {
      await runtime.stop();
      return "stop";
    }
    return "none";
  }
  if (!apiKey?.trim()) return "none";
  if (state === "running" || state === "starting" || state === "stopping") {
    await runtime.restart();
    return "restart";
  }
  await runtime.start();
  return "start";
}

export async function reconcileOpenCodeSettings(
  runtime: OpenCodeLifecycleRuntime,
  before: OpenCodeSettingsSnapshot,
  after: OpenCodeSettingsSnapshot,
  hasProject = true
): Promise<OpenCodeLifecycleAction> {
  const beforeKey = before.apiKey?.trim();
  const afterKey = after.apiKey?.trim();
  const state = runtime.status().state;

  if (!afterKey) {
    if (state !== "stopped") {
      await runtime.stop();
      return "stop";
    }
    return "none";
  }

  if (!hasProject) {
    if (state !== "stopped") {
      await runtime.stop();
      return "stop";
    }
    return "none";
  }

  if (!beforeKey) {
    await runtime.start();
    return "start";
  }

  const changed = before.baseUrl !== after.baseUrl || before.model !== after.model || beforeKey !== afterKey;
  if (!changed) return "none";

  if (state === "running" || state === "starting" || state === "stopping") {
    await runtime.restart();
    return "restart";
  }

  if (state === "error") {
    await runtime.start();
    return "start";
  }

  return "none";
}
