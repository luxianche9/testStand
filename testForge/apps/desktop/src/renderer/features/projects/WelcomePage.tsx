import { lazy, Suspense, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import "@xyflow/react/dist/style.css";
import type { Hardware } from "@testforge/contracts/devices";
import type { ProjectFolderSelection, RecentProjectSummary } from "@testforge/contracts/projects";
import { FolderOpenIcon, Grid2X2Icon, ListIcon, Trash2Icon } from "lucide-react";
import { Button, Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, Spinner, cn } from "../../shared/ui/index.js";
import { errorMessage } from "../../shared/errors.js";
import { useDeviceCatalog, useRecentProjects } from "../../shared/queries.js";
import { queryKeys } from "../../shared/query-keys.js";
const TopologyPreview = lazy(() => import("../wiring/TopologyPreview.js").then((module) => ({ default: module.TopologyPreview })));

export function WelcomePage({ onOpened }: { onOpened: (rootPath: string) => Promise<void> | void }) {
  const client = useQueryClient();
  const recent = useRecentProjects();
  const catalog = useDeviceCatalog();
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [selection, setSelection] = useState<ProjectFolderSelection>();
  const [error, setError] = useState<string>();

  useEffect(() => { void window.testforge.settings.getWelcomeLayout().then(setLayout); }, []);

  const openSelection = async (next: ProjectFolderSelection) => {
    setError(undefined);
    if (next.state === "invalid") {
      setError(next.message ?? "项目清单无法读取。");
      return;
    }
    if (next.state === "uninitialized") {
      setSelection(next);
      return;
    }
    await window.testforge.projects.openFolder(next.rootPath);
    await onOpened(next.rootPath);
  };

  const choose = useMutation({
    mutationFn: () => window.testforge.projects.chooseFolder(),
    onSuccess: async (next) => { if (next) await openSelection(next); },
    onError: (reason) => setError(errorMessage(reason))
  });
  const initialize = useMutation({
    mutationFn: async () => {
      if (!selection) return null;
      return await window.testforge.projects.initializeFolder(selection.rootPath);
    },
    onSuccess: async (document) => {
      if (!document) return;
      setSelection(undefined);
      await onOpened(document.rootPath);
    },
    onError: (reason) => setError(errorMessage(reason))
  });
  const openRecent = useMutation({
    mutationFn: (rootPath: string) => window.testforge.projects.openFolder(rootPath),
    onSuccess: async (document) => { await onOpened(document.rootPath); },
    onError: (reason) => setError(errorMessage(reason))
  });
  const forget = useMutation({
    mutationFn: (rootPath: string) => window.testforge.projects.forgetRecent(rootPath),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: queryKeys.recentProjects }); }
  });

  const changeLayout = (next: "grid" | "list") => {
    setLayout(next);
    void window.testforge.settings.setWelcomeLayout(next);
  };
  const busy = choose.isPending || initialize.isPending || openRecent.isPending;

  return (
    <main className="min-h-0 flex-1 overflow-auto bg-background px-[clamp(28px,5vw,76px)] pt-8 pb-16">
      <section className="mx-auto max-w-[1180px]" aria-labelledby="recent-projects-title">
        <header className="mb-3 flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-2.5">
            <h2 id="recent-projects-title" className="m-0 text-sm font-semibold">最近项目</h2>
            <span className="text-xs text-muted-foreground">{recent.data?.length ?? 0} 个项目</span>
          </div>
          <div className="flex rounded-md border bg-secondary/50 p-0.5" role="group" aria-label="最近项目布局">
            <button
              type="button"
              className={cn("grid h-6.5 w-7 place-items-center rounded-sm text-muted-foreground transition-colors", layout === "grid" && "bg-background text-primary shadow-sm")}
              aria-label="卡片布局"
              aria-pressed={layout === "grid"}
              onClick={() => changeLayout("grid")}
            >
              <Grid2X2Icon size={15} />
            </button>
            <button
              type="button"
              className={cn("grid h-6.5 w-7 place-items-center rounded-sm text-muted-foreground transition-colors", layout === "list" && "bg-background text-primary shadow-sm")}
              aria-label="列表布局"
              aria-pressed={layout === "list"}
              onClick={() => changeLayout("list")}
            >
              <ListIcon size={16} />
            </button>
          </div>
        </header>

        {error && (
          <div className="mb-3 flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/6 px-3.5 py-2.5 text-xs whitespace-pre-wrap break-anywhere text-destructive">
            {error}
          </div>
        )}
        {recent.isLoading ? (
          <div className="grid min-h-[220px] place-items-center"><Spinner label="正在读取最近项目…" /></div>
        ) : (
          <div className={layout === "grid" ? "grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3.5" : "grid gap-2"}>
            {(recent.data ?? []).map((item) => (
              <RecentProject
                key={item.rootPath}
                project={item}
                hardware={catalog.data?.hardware ?? []}
                layout={layout}
                disabled={busy}
                onOpen={() => openRecent.mutate(item.rootPath)}
                onForget={() => forget.mutate(item.rootPath)}
              />
            ))}
            <button
              type="button"
              className={cn(
                "grid place-content-center justify-items-center gap-2 rounded-md border border-dashed text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-primary",
                layout === "grid" ? "min-h-[190px]" : "min-h-[68px] grid-flow-col items-center"
              )}
              onClick={() => choose.mutate()}
              disabled={busy}
            >
              <FolderOpenIcon size={22} />
              <span>打开项目文件夹</span>
            </button>
          </div>
        )}
      </section>

      <Dialog open={Boolean(selection)} onOpenChange={(open) => { if (!open && !initialize.isPending) setSelection(undefined); }}>
        <DialogContent size="sm">
          <DialogHeader title="初始化 TestForge 项目" />
          <DialogBody>
            <p className="m-0 text-sm">
              文件夹 <strong>{selection?.name}</strong> 中还没有 <code className="font-mono">.testforge/project.json</code>。
            </p>
            <p className="mt-2 mb-0 text-xs leading-relaxed text-muted-foreground">继续只会创建 TestForge 清单，不会修改文件夹中的其他内容。</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={initialize.isPending} onClick={() => setSelection(undefined)}>取消</Button>
            <Button disabled={initialize.isPending} onClick={() => initialize.mutate()}>{initialize.isPending ? "正在创建…" : "创建并打开"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function RecentProject({ project, hardware, layout, disabled, onOpen, onForget }: {
  project: RecentProjectSummary;
  hardware: Hardware[];
  layout: "grid" | "list";
  disabled: boolean;
  onOpen: () => void;
  onForget: () => void;
}) {
  const isGrid = layout === "grid";
  const unavailable = project.status !== "available";
  return (
    <article className={cn(
      "relative min-w-0 overflow-hidden rounded-md border bg-card transition-colors hover:border-ring/50",
      unavailable && "opacity-75",
      !isGrid && "min-h-[76px]"
    )}>
      <button
        type="button"
        className={cn(
          "w-full min-w-0 text-left disabled:cursor-default",
          isGrid ? "grid" : "grid grid-cols-[112px_minmax(0,1fr)] items-stretch"
        )}
        disabled={disabled || unavailable}
        onClick={onOpen}
      >
        <Suspense fallback={<TopologyPreviewPlaceholder projectName={project.name} compact={!isGrid} />}>
          <TopologyPreview project={project} hardware={hardware} compact={!isGrid} />
        </Suspense>
        <span className="grid min-w-0 gap-0.5 pt-2.5 pr-9.5 pb-3 pl-3">
          <strong className="truncate text-[13px]">{project.name}</strong>
          <small className="truncate text-left text-xs text-muted-foreground" style={{ direction: "rtl" }}>{project.rootPath}</small>
          <span className="text-[11px] text-muted-foreground/70">{project.status === "available" ? `更新于 ${formatTime(project.updatedAt ?? project.openedAt)}` : project.message ?? statusLabel(project.status)}</span>
        </span>
      </button>
      <button
        type="button"
        className={cn(
          "absolute right-2 grid size-6.5 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-destructive/8 hover:text-destructive",
          isGrid ? "bottom-2" : "top-1/2 -translate-y-1/2"
        )}
        aria-label={`从最近项目移除 ${project.name}`}
        title="从最近项目移除"
        onClick={onForget}
      >
        <Trash2Icon size={14} />
      </button>
    </article>
  );
}

function TopologyPreviewPlaceholder({ projectName, compact }: { projectName: string; compact: boolean }) {
  return <div className={cn("topology-preview", compact && "compact")} role="img" aria-label={`${projectName} 工位接线缩略图`} />;
}
function statusLabel(status: RecentProjectSummary["status"]) { return status === "missing" ? "项目文件夹不存在" : "项目清单无效"; }
function formatTime(value: string) { try { return new Date(value).toLocaleString(); } catch { return value; } }
