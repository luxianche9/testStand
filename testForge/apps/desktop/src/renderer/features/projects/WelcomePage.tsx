import { lazy, Suspense, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import "@xyflow/react/dist/style.css";
import type { Hardware } from "@testforge/contracts/devices";
import type { ProjectFolderSelection, RecentProjectSummary } from "@testforge/contracts/projects";
import { FolderOpenIcon, Grid2X2Icon, ListIcon, Trash2Icon } from "lucide-react";
import { Btn, Modal, Spinner } from "../../shared/ui.js";
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
    <main className="welcome-page">
      <section className="recent-section" aria-labelledby="recent-projects-title">
        <header className="recent-head">
          <div><h2 id="recent-projects-title">最近项目</h2><span>{recent.data?.length ?? 0} 个项目</span></div>
          <div className="layout-toggle" role="group" aria-label="最近项目布局">
            <button className={layout === "grid" ? "active" : ""} aria-label="卡片布局" aria-pressed={layout === "grid"} onClick={() => changeLayout("grid")}><Grid2X2Icon size={15} /></button>
            <button className={layout === "list" ? "active" : ""} aria-label="列表布局" aria-pressed={layout === "list"} onClick={() => changeLayout("list")}><ListIcon size={16} /></button>
          </div>
        </header>

        {error && <div className="alert welcome-alert">{error}</div>}
        {recent.isLoading ? <div className="welcome-loading"><Spinner label="正在读取最近项目…" /></div> : (
          <div className={`recent-projects ${layout}`}>
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
            <button className="recent-open-card" onClick={() => choose.mutate()} disabled={busy}>
              <FolderOpenIcon size={22} />
              <span>打开项目文件夹</span>
            </button>
          </div>
        )}
      </section>

      <Modal
        open={Boolean(selection)}
        onClose={() => !initialize.isPending && setSelection(undefined)}
        title="初始化 TestForge 项目"
        footer={<><Btn disabled={initialize.isPending} onClick={() => setSelection(undefined)}>取消</Btn><Btn variant="primary" disabled={initialize.isPending} onClick={() => initialize.mutate()}>{initialize.isPending ? "正在创建…" : "创建并打开"}</Btn></>}
      >
        <p>文件夹 <strong>{selection?.name}</strong> 中还没有 <code>.testforge/project.json</code>。</p>
        <p className="form-note">继续只会创建 TestForge 清单，不会修改文件夹中的其他内容。</p>
      </Modal>
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
  return (
    <article className={`recent-project ${project.status}`}>
      <button className="recent-project-main" disabled={disabled || project.status !== "available"} onClick={onOpen}>
        <Suspense fallback={<TopologyPreviewPlaceholder projectName={project.name} compact={layout === "list"} />}>
          <TopologyPreview project={project} hardware={hardware} compact={layout === "list"} />
        </Suspense>
        <span className="recent-project-copy">
          <strong>{project.name}</strong>
          <small>{project.rootPath}</small>
          <span>{project.status === "available" ? `更新于 ${formatTime(project.updatedAt ?? project.openedAt)}` : project.message ?? statusLabel(project.status)}</span>
        </span>
      </button>
      <button className="recent-forget" aria-label={`从最近项目移除 ${project.name}`} title="从最近项目移除" onClick={onForget}><Trash2Icon size={14} /></button>
    </article>
  );
}

function TopologyPreviewPlaceholder({ projectName, compact }: { projectName: string; compact: boolean }) {
  return <div className={`topology-preview${compact ? " compact" : ""}`} role="img" aria-label={`${projectName} 工位接线缩略图`} />;
}
function statusLabel(status: RecentProjectSummary["status"]) { return status === "missing" ? "项目文件夹不存在" : "项目清单无效"; }
function formatTime(value: string) { try { return new Date(value).toLocaleString(); } catch { return value; } }
