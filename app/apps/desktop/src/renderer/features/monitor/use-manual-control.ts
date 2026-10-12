import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ToolCatalogItem } from "@teststand/contracts/devices";
import { activeExecutionActivities } from "@teststand/contracts/execution";
import { errorMessage } from "../../lib/errors.js";
import { useDashboard } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import { actionName, deviceActions } from "../bench/device-actions.js";

const TIMEOUT_MS = 30_000;
const HISTORY = 50;

/** One manual call made from the workspace (newest first in `history`). */
export interface ManualCall {
  id: number;
  at: number;
  hardwareId: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** The tool's output as JSON, or the error. */
  message: string;
}

let calls = 0;

/**
 * Manual control from the monitor workspace: the device tools, who may call them now, and the
 * call itself. A device a test run is using cannot be controlled by hand (the backend refuses
 * too); every call is kept in `history` with its arguments and its result or error.
 */
export function useManualControl() {
  const client = useQueryClient();
  const dashboard = useDashboard();
  const [history, setHistory] = useState<ManualCall[]>([]);
  const tools = dashboard.data?.tools;
  const devices = dashboard.data?.devices;
  const execution = dashboard.data?.execution;

  /** Devices a running test holds. */
  const held = useMemo(() => new Set(activeExecutionActivities(execution)
    .flatMap((item) => (item.state === "run" ? item.hardwareIds : []))), [execution]);
  const running = useMemo(() => activeExecutionActivities(execution).some((item) => item.state === "run"),
    [execution]);
  const deviceIdOf = useCallback((hardwareId: string) =>
    devices?.find((item) => item.hardwareId === hardwareId)?.deviceId, [devices]);
  /** The tools an operator may call on a device (no platform tools, no stream plumbing). */
  const toolsOf = useCallback((hardwareId: string): ToolCatalogItem[] =>
    deviceActions(tools ?? [], deviceIdOf(hardwareId)), [tools, deviceIdOf]);
  const findTool = useCallback((hardwareId: string, name: string): ToolCatalogItem | undefined => {
    const own = toolsOf(hardwareId);
    return own.find((tool) => tool.remoteName === name) ?? own.find((tool) => actionName(tool, own) === name);
  }, [toolsOf]);
  /** Why the device cannot be controlled now, or undefined when it can. */
  const lockOf = useCallback((hardwareId: string): string | undefined =>
    held.has(hardwareId) ? "测试运行中" : undefined, [held]);

  const call = useCallback(async (hardwareId: string, name: string, args: Record<string, unknown>) => {
    const tool = findTool(hardwareId, name);
    const record = (ok: boolean, message: string) => setHistory((current) => [
      { id: ++calls, at: Date.now(), hardwareId, tool: name, args, ok, message }, ...current
    ].slice(0, HISTORY));
    const locked = lockOf(hardwareId);
    if (locked) {
      record(false, locked);
      throw new Error(`${hardwareId} ${locked}，不能手动控制`);
    }
    if (!tool) {
      record(false, "设备没有这个工具或设备离线");
      throw new Error(`${hardwareId} 没有工具 ${name}（设备离线？）`);
    }
    try {
      const result = await window.teststand.manual.invokeTool({
        raw: { hardwareId, toolName: tool.externalName, arguments: args, timeoutMs: TIMEOUT_MS }
      });
      record(true, JSON.stringify(result.output));
      return result;
    } catch (cause) {
      record(false, errorMessage(cause));
      throw cause;
    } finally {
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    }
  }, [client, findTool, lockOf]);

  /** Every device's safe-state tool, one after another; failures are collected, not fatal. */
  const safeAll = useCallback(async (): Promise<string[]> => {
    const failures: string[] = [];
    for (const device of devices ?? []) {
      const safe = toolsOf(device.hardwareId)
        .find((tool) => tool.contractMetadata?.operationSemantics?.kind === "safe");
      if (!safe) continue;
      try {
        await call(device.hardwareId, safe.remoteName, {});
      } catch (cause) {
        failures.push(`${device.label || device.hardwareId}：${errorMessage(cause)}`);
      }
    }
    return failures;
  }, [devices, toolsOf, call]);

  return { tools: tools ?? [], running, toolsOf, findTool, lockOf, call, safeAll, history };
}

export type ManualControl = ReturnType<typeof useManualControl>;
