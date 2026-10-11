import type { ToolCatalogItem } from "@teststand/contracts/devices";
import { invocationPayload } from "../manual/invocation-readings.js";

/** One check of a plugin's self-test, as the SDK's `self_test` tool returns it. */
type SelfTestCheck = { name: string; passed: boolean; measured: string; expected: string; detail: string };

export type SelfTestReport = { passed: boolean; checks: SelfTestCheck[]; durationMs?: number; dryRun: boolean };

/** The device's builtin `self_test`, present only when its plugin implements one. */
export function selfTestTool(
  tools: readonly ToolCatalogItem[],
  deviceId: string | undefined
): ToolCatalogItem | undefined {
  if (!deviceId) return undefined;
  return tools.find((tool) => tool.deviceId === deviceId && tool.remoteName === "self_test");
}

/** A measured or expected value as one line: text as is, numbers trimmed, lists and maps as compact JSON. */
export function checkValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
  if (typeof value === "boolean") return value ? "是" : "否";
  return JSON.stringify(value);
}

/** The `self_test` result, or undefined when the output is not one. */
export function selfTestReport(output: unknown): SelfTestReport | undefined {
  const data = invocationPayload(output);
  if (!data || typeof data.passed !== "boolean" || !Array.isArray(data.checks)) return undefined;
  const checks = data.checks.flatMap((item): SelfTestCheck[] => {
    if (!item || typeof item !== "object") return [];
    const check = item as Record<string, unknown>;
    return [{
      name: String(check.name ?? ""),
      passed: check.passed === true,
      measured: checkValue(check.measured),
      expected: checkValue(check.expected),
      detail: typeof check.detail === "string" ? check.detail : ""
    }];
  });
  const report: SelfTestReport = { passed: data.passed, checks, dryRun: data.dryRun === true };
  if (typeof data.durationMs === "number") report.durationMs = data.durationMs;
  return report;
}
