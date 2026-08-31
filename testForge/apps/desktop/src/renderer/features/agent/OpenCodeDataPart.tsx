import { WrenchIcon } from "lucide-react";

function summary(name: string, data: unknown) {
  if (name === "opencode-unsupported-part" && typeof data === "object" && data && "type" in data && typeof data.type === "string") return `暂不支持的内容：${data.type}`;
  if (name === "opencode-snapshot") return "工作区快照";
  if (name === "opencode-retry") return "正在重试";
  if (name === "opencode-compaction") return "上下文已压缩";
  if (name === "opencode-agent") return "Agent 事件";
  if (name === "opencode-subtask") return "子任务";
  return name.replace(/^opencode-/, "").replace(/-/g, " ");
}

export function OpenCodeDataPart({ name, data }: { name: string; data: unknown }) {
  if (["opencode-step-start", "opencode-step-finish", "opencode-patch"].includes(name)) return null;
  return <div className="my-3 flex w-min items-center gap-2 text-nowrap rounded-full bg-muted/30 px-2 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06]"><WrenchIcon className="size-3" />{summary(name, data)}</div>;
}
