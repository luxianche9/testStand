import type { RecentProjectSummary } from "@teststand/contracts/projects";
import type { WelcomeLayout } from "@teststand/contracts/storage";
import { CableIcon, EllipsisIcon, Trash2Icon, WorkflowIcon } from "lucide-react";
import { Button, Menu, MenuContent, MenuItem, MenuTrigger, StatusLamp, cn } from "../../ui";

type ItemProps = {
  project: RecentProjectSummary;
  disabled: boolean;
  onOpen: () => void;
  onForget: () => void;
};

/** Recent projects as a dense table (list) or thumbnail cards (grid). */
export function RecentProjectList({ projects, layout, disabled, onOpen, onForget }: {
  projects: RecentProjectSummary[];
  layout: WelcomeLayout;
  disabled: boolean;
  onOpen: (rootPath: string) => void;
  onForget: (rootPath: string) => void;
}) {
  const itemProps = (project: RecentProjectSummary): ItemProps => ({
    project,
    disabled,
    onOpen: () => onOpen(project.rootPath),
    onForget: () => onForget(project.rootPath)
  });

  if (layout === "grid") {
    return (
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-3 p-4">
        {projects.map((project) => <ProjectCard key={project.rootPath} {...itemProps(project)} />)}
      </ul>
    );
  }
  return (
    <div>
      <div
        aria-hidden
        className={cn(
          "sticky top-0 z-[1] grid h-6 grid-cols-[104px_minmax(0,1fr)_168px_36px] items-center gap-3",
          "border-b border-line bg-surface-0 px-3"
        )}
      >
        <span className="tf-label">预览</span>
        <span className="tf-label">项目 / 路径</span>
        <span className="tf-label text-right">更新时间</span>
        <span />
      </div>
      <ul>
        {projects.map((project) => <ProjectRow key={project.rootPath} {...itemProps(project)} />)}
      </ul>
    </div>
  );
}

function ProjectRow({ project, disabled, onOpen, onForget }: ItemProps) {
  const unavailable = project.status !== "available";
  return (
    <li
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_36px] items-center gap-3 border-b border-line pr-3",
        "transition-colors duration-120",
        "hover:bg-surface-1 focus-within:bg-surface-1",
        unavailable && "opacity-70"
      )}
    >
      <button
        type="button"
        className={cn(
          "grid min-w-0 grid-cols-[104px_minmax(0,1fr)_168px] items-center gap-3 py-2 pl-3 text-left",
          "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal",
          "disabled:cursor-default"
        )}
        disabled={disabled || unavailable}
        onClick={onOpen}
      >
        <span
          className={cn(
            "block h-12 w-[104px] overflow-hidden rounded-sm border border-line"
          )}
        >
          <ProjectPreview project={project} compact />
        </span>
        <ProjectCaption project={project} />
        <span className={cn("tf-num truncate text-right text-xs", unavailable ? "text-invalid" : "text-fg-3")}>
          {unavailable ? statusText(project) : formatTime(project.updatedAt ?? project.openedAt)}
        </span>
      </button>
      <ProjectMenu project={project} onForget={onForget} className="justify-self-center" />
    </li>
  );
}

function ProjectCard({ project, disabled, onOpen, onForget }: ItemProps) {
  const unavailable = project.status !== "available";
  return (
    <li
      className={cn(
        "relative min-w-0 overflow-hidden rounded-md border border-line bg-surface-1",
        "transition-colors duration-120 hover:border-line-strong focus-within:border-signal/60",
        unavailable && "opacity-70"
      )}
    >
      <button
        type="button"
        className="grid w-full min-w-0 text-left outline-none disabled:cursor-default"
        disabled={disabled || unavailable}
        onClick={onOpen}
      >
        <ProjectPreview project={project} compact={false} />
        <span className="grid min-w-0 gap-1 border-t border-line py-2 pr-10 pl-3">
          <ProjectCaption project={project} />
          <span className={cn("tf-num truncate text-2xs", unavailable ? "text-invalid" : "text-fg-3")}>
            {unavailable ? statusText(project) : `更新于 ${formatTime(project.updatedAt ?? project.openedAt)}`}
          </span>
        </span>
      </button>
      <ProjectMenu project={project} onForget={onForget} className="absolute right-1.5 bottom-2" />
    </li>
  );
}

function ProjectCaption({ project }: { project: RecentProjectSummary }) {
  const unavailable = project.status !== "available";
  return (
    <span className="grid min-w-0 gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        {unavailable && <StatusLamp tone={project.status === "missing" ? "fail" : "invalid"} />}
        <span className="truncate text-sm font-medium text-fg">{project.name}</span>
      </span>
      {/* rtl keeps the tail of long paths visible; the inner bdi keeps the path itself left-to-right. */}
      <span className="truncate text-left font-mono text-2xs text-fg-3" dir="rtl" title={project.rootPath}>
        <bdi dir="ltr">{project.rootPath}</bdi>
      </span>
    </span>
  );
}

function ProjectMenu({ project, onForget, className }: {
  project: RecentProjectSummary;
  onForget: () => void;
  className?: string;
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className={className} aria-label={`更多操作：${project.name}`}>
          <EllipsisIcon />
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem danger onSelect={onForget}>
          <Trash2Icon />
          从最近项目移除
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** What the project holds: its physical connections and the nodes of its signal view. */
function ProjectPreview({ project, compact }: { project: RecentProjectSummary; compact: boolean }) {
  const { connections, nodes } = project.preview;
  return (
    <span
      role="img"
      aria-label={`${project.name}：${connections} 条接线，信号视图 ${nodes} 个节点`}
      className={cn(
        "flex w-full items-center justify-center gap-4 bg-canvas font-mono text-fg-3",
        compact ? "h-12 gap-2 text-2xs" : "h-[132px] text-xs"
      )}
    >
      <span className="flex items-center gap-1"><CableIcon aria-hidden className="size-3.5" />{connections}</span>
      <span className="flex items-center gap-1"><WorkflowIcon aria-hidden className="size-3.5" />{nodes}</span>
    </span>
  );
}

function statusText(project: RecentProjectSummary) {
  return project.message ?? (project.status === "missing" ? "项目文件夹不存在" : "项目清单无效");
}

function formatTime(value: string) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}
