import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ActivityIcon, CheckCircle2Icon, ListTreeIcon } from "lucide-react";
import { Button } from "../../../shared/ui/button";
import { Badge } from "../../../shared/ui/badge";
import { ToolFallback } from "../ToolFallback";

export const TestPlanTool: ToolCallMessagePartComponent = ({ toolName, argsText, result, status }) => {
  const data = extractData(result);
  const plan = record(data?.plan) ?? data;
  const run = record(data?.run) ?? data;
  const revision = numberValue(plan?.revision ?? data?.revision);
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  const applied = numberValue(data?.appliedOperations);
  const verdict = stringValue(run?.verdict);
  const planName = stringValue(plan?.name ?? run?.planName);
  return <ToolFallback.Root defaultOpen={status?.type === "incomplete"} className="my-1 rounded-lg border bg-secondary/10 px-2.5">
    <ToolFallback.Trigger toolName={friendlyName(toolName)} status={status} />
    <ToolFallback.Content>
      <div className="grid gap-2 rounded-md border bg-background p-3 text-xs">
        <div className="flex items-center gap-2"><ListTreeIcon className="size-4 text-primary"/><strong className="min-w-0 flex-1 truncate">{planName || "HardwareHarness 测试计划"}</strong>{revision !== undefined && <Badge variant="outline">rev {revision}</Badge>}</div>
        <div className="flex flex-wrap gap-1.5">{applied !== undefined && <Badge variant="secondary">修改 {applied} 个节点</Badge>}<Badge variant={issues.some((item) => record(item)?.severity === "error") ? "destructive" : "success"}>{issues.length ? `${issues.length} 个校验问题` : "校验通过"}</Badge>{verdict && <Badge variant={verdict === "Pass" ? "success" : verdict === "Fail" || verdict === "Error" ? "destructive" : "secondary"}><ActivityIcon className="mr-1 size-3"/>{verdict}</Badge>}</div>
        {stringValue(run?.state) && <div className="flex items-center gap-1 text-muted-foreground"><CheckCircle2Icon className="size-3.5"/>运行状态：{stringValue(run?.state)}</div>}
        <Button size="xs" variant="outline" className="w-fit" onClick={() => window.dispatchEvent(new CustomEvent("hardwareharness:navigate-plans"))}>在测试计划页查看</Button>
      </div>
      {status?.type === "incomplete" && <ToolFallback.Error status={status} />}
      <ToolFallback.Args argsText={argsText} />
    </ToolFallback.Content>
  </ToolFallback.Root>;
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
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function extractData(value: unknown): Record<string, unknown> | undefined { const direct = record(value); if (direct) return record(direct.data) ?? direct; if (typeof value === "string") { try { return extractData(JSON.parse(value)); } catch { return undefined; } } return undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
