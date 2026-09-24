import { WrenchIcon } from "lucide-react";

function summary(name: string, data: unknown) {
  if (name === "opencode-unsupported-part" && typeof data === "object" && data && "type" in data) {
    if (typeof data.type === "string") return `暂不支持的内容：${data.type}`;
  }
  if (name === "opencode-snapshot") return "工作区快照";
  if (name === "opencode-retry") return "正在重试";
  if (name === "opencode-compaction") return "上下文已压缩";
  if (name === "opencode-agent") return "Agent 事件";
  if (name === "opencode-subtask") return "子任务";
  return name.replace(/^opencode-/, "").replace(/-/g, " ");
}

export function OpenCodeDataPart({ name, data }: { name: string; data: unknown }) {
  if (["opencode-step-start", "opencode-step-finish", "opencode-patch"].includes(name)) return null;
  return (
    <div
      className={
        "my-2 flex w-fit max-w-full items-center gap-1.5 rounded-sm border border-line bg-surface-2/60 " +
        "px-1.5 py-0.5 text-2xs text-nowrap text-fg-3"
      }
    >
      <WrenchIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{summary(name, data)}</span>
    </div>
  );
}
