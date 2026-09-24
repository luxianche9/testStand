import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ActivityIcon, ListTreeIcon } from "lucide-react";
import { Badge, Button, StatusLamp, type Tone } from "../../../ui";
import { ToolFallback } from "../ToolFallback";

function verdictBadgeTone(verdict: string): Tone {
  if (verdict === "Pass") return "pass";
  if (verdict === "Fail" || verdict === "Error") return "fail";
  return "neutral";
}

export const TestPlanTool: ToolCallMessagePartComponent = ({ toolName, argsText, result, status }) => {
  const data = extractData(result);
  const plan = record(data?.plan) ?? data;
  const run = record(data?.run) ?? data;
  const revision = numberValue(plan?.revision ?? data?.revision);
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  const hasErrors = issues.some((item) => record(item)?.severity === "error");
  const applied = numberValue(data?.appliedOperations);
  const verdict = stringValue(run?.verdict);
  const planName = stringValue(plan?.name ?? run?.planName);
  const runState = stringValue(run?.state);
  return (
    <ToolFallback.Root defaultOpen={status?.type === "incomplete"}>
      <ToolFallback.Trigger toolName={friendlyName(toolName)} status={status} />
      <ToolFallback.Content>
        <div className="grid gap-2 rounded-sm border border-line bg-surface-1 p-2.5 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            <ListTreeIcon aria-hidden className="size-3.5 shrink-0 text-signal" />
            <strong className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
              {planName || "HardwareHarness 测试计划"}
            </strong>
            {revision !== undefined && <Badge className="tf-num">rev {revision}</Badge>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {applied !== undefined && <Badge>修改 {applied} 个节点</Badge>}
            <Badge tone={hasErrors ? "fail" : "pass"}>
              {issues.length ? `${issues.length} 个校验问题` : "校验通过"}
            </Badge>
            {verdict && (
              <Badge mono tone={verdictBadgeTone(verdict)}>
                <ActivityIcon aria-hidden className="size-3" />
                {verdict}
              </Badge>
            )}
          </div>
          {runState && (
            <div className="flex items-center gap-1.5 text-fg-2">
              <StatusLamp tone="run" />
              运行状态：<span className="font-mono text-fg">{runState}</span>
            </div>
          )}
          <Button
            size="xs"
            variant="outline"
            className="w-fit"
            onClick={() => window.dispatchEvent(new CustomEvent("hardwareharness:navigate-plans"))}
          >
            在测试计划页查看
          </Button>
        </div>
        {status?.type === "incomplete" && <ToolFallback.Error status={status} />}
        <ToolFallback.Args argsText={argsText} />
      </ToolFallback.Content>
    </ToolFallback.Root>
  );
};

function friendlyName(name: string): string {
  if (name.includes("validate")) return "校验测试计划";
  if (name.includes("operations")) return "修改测试计划";
  if (name.includes("create")) return "创建测试计划";
  if (name.includes("start")) return "启动测试运行";
  if (name.includes("pause")) return "暂停测试运行";
  if (name.includes("resume")) return "继续测试运行";
  if (name.includes("abort")) return "终止测试运行";
  if (name.includes("wait")) return "等待测试运行";
  return name;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function extractData(value: unknown): Record<string, unknown> | undefined {
  const direct = record(value);
  if (direct) return record(direct.data) ?? direct;
  if (typeof value === "string") {
    try { return extractData(JSON.parse(value)); } catch { return undefined; }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
