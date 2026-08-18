import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectDocument, ProjectFolderSelection } from "@testforge/contracts/projects";
import type { WiringTask } from "@testforge/contracts/wiring";
import type { HardwareOccupancyRequest } from "@testforge/contracts/occupancy";
import { Spinner, Btn, Modal } from "../shared/ui.js";
import { useDashboard, useDeviceCatalog, useOccupancyRequests, useProjectDocument, useWiringTasks } from "../shared/queries.js";
import { useTheme } from "../shared/theme.js";
import type { ProjectView } from "@testforge/contracts/storage";
import { pinCountText, taskTitle, taskTone } from "../features/wiring/wiring-model.js";
import { ErrorBoundary } from "../shared/ErrorBoundary.js";
import { errorMessage } from "../shared/errors.js";
import { queryKeys } from "../shared/query-keys.js";
import { invalidateWiringData } from "../shared/mutations.js";
import { appNavigationReducer, initialAppNavigation, isProjectView, type AppPage } from "./app-navigation.js";
import { readAssistantOpen, writeAssistantOpen } from "./assistant-preference.js";
import { TitleBar } from "./TitleBar.js";

const AssistantSidebar = lazy(() => import("../features/agent/assistant.js").then((module) => ({ default: module.AssistantSidebar })));
const ProjectWorkspace = lazy(() => import("../features/projects/ProjectWorkspace.js").then((module) => ({ default: module.ProjectWorkspace })));
const WelcomePage = lazy(() => import("../features/projects/WelcomePage.js").then((module) => ({ default: module.WelcomePage })));
const SettingsPage = lazy(() => import("../features/settings/SettingsPage.js").then((module) => ({ default: module.SettingsPage })));

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

type PendingAction = { run: () => Promise<void>; label: string };

export function App() {
  return <QueryClientProvider client={queryClient}><AppShell /></QueryClientProvider>;
}

function AppShell() {
  const client = useQueryClient();
  const theme = useTheme();
  const dashboard = useDashboard();
  const project = useProjectDocument();
  const [navigation, navigate] = useReducer(appNavigationReducer, initialAppNavigation);
  const [assistantOpen, setAssistantOpen] = useState(readAssistantOpen);
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const [pendingSelection, setPendingSelection] = useState<ProjectFolderSelection>();
  const [error, setError] = useState<string>();
  const wiringTasks = useWiringTasks();
  const occupancyRequests = useOccupancyRequests();
  const catalog = useDeviceCatalog();
  const [wiringLogOpen, setWiringLogOpen] = useState(false);

  const syncProject = useCallback(async (document?: ProjectDocument | null) => {
    if (document !== undefined) client.setQueryData(queryKeys.projectDocument, document);
    else await client.invalidateQueries({ queryKey: queryKeys.projectDocument });
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.recentProjects }),
      client.invalidateQueries({ queryKey: queryKeys.wiringTasks }),
      client.invalidateQueries({ queryKey: queryKeys.occupancyRequests }),
      client.invalidateQueries({ queryKey: queryKeys.openCodeStatus })
    ]);
  }, [client]);

  useEffect(() => window.testforge.events.subscribe("availability", () => { void client.invalidateQueries({ queryKey: queryKeys.dashboard }); }), [client]);
  useEffect(() => window.testforge.events.subscribe("execution", () => { void client.invalidateQueries({ queryKey: queryKeys.dashboard }); }), [client]);
  useEffect(() => window.testforge.events.subscribe("occupancy", () => { void client.invalidateQueries({ queryKey: queryKeys.dashboard }); }), [client]);
  useEffect(() => window.testforge.events.subscribe("occupancyRequest", () => { void client.invalidateQueries({ queryKey: queryKeys.occupancyRequests }); }), [client]);
  useEffect(() => window.testforge.events.subscribe("project", (payload) => {
    client.setQueryData(queryKeys.projectDocument, payload as ProjectDocument | null);
    void client.invalidateQueries({ queryKey: queryKeys.wiringTasks });
  }), [client]);
  useEffect(() => window.testforge.events.subscribe("wiringTask", () => {
    void client.invalidateQueries({ queryKey: queryKeys.wiringTasks });
    void client.invalidateQueries({ queryKey: queryKeys.projectDocument });
  }), [client]);
  useEffect(() => {
    const fallback = window.setInterval(() => {
      void client.invalidateQueries({ queryKey: queryKeys.wiringTasks });
      void client.invalidateQueries({ queryKey: queryKeys.occupancyRequests });
    }, 15_000);
    return () => window.clearInterval(fallback);
  }, [client]);
  useEffect(() => { writeAssistantOpen(assistantOpen); }, [assistantOpen]);
  useEffect(() => { if (!project.data) setAssistantOpen(false); }, [project.data]);
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!project.data?.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [project.data?.dirty]);

  const save = useMutation({
    mutationFn: () => window.testforge.projects.save(),
    onSuccess: (document) => void syncProject(document),
    onError: (reason) => setError(errorMessage(reason))
  });
  const saveShortcutRef = useRef(save.mutateAsync);
  useEffect(() => { saveShortcutRef.current = save.mutateAsync; }, [save.mutateAsync]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s" || !project.data) return;
      event.preventDefault();
      void saveShortcutRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project.data]);

  const guardDirty = useCallback((label: string, run: () => Promise<void>) => {
    if (!project.data?.dirty) { void run(); return; }
    setPendingAction({ label, run });
  }, [project.data?.dirty]);

  const enterProject = useCallback(async (rootPath: string) => {
    await syncProject();
    const savedView = await window.testforge.settings.getProjectView();
    navigate({ type: "enter-project", view: savedView });
    setAssistantOpen(readAssistantOpen());
    setError(undefined);
    void rootPath;
  }, [syncProject]);

  const goWelcome = useCallback(async () => {
    await window.testforge.projects.leave();
    await syncProject(null);
    setAssistantOpen(false);
    navigate({ type: "show-content", page: "welcome" });
  }, [syncProject]);

  const chooseAndOpen = useCallback(async () => {
    const selection = await window.testforge.projects.chooseFolder();
    if (!selection) return;
    if (selection.state === "invalid") throw new Error(selection.message ?? "项目清单无法读取。");
    if (selection.state === "uninitialized") { setPendingSelection(selection); return; }
    const document = await window.testforge.projects.openFolder(selection.rootPath);
    await enterProject(document.rootPath);
  }, [enterProject]);

  const switchPage = (next: AppPage) => {
    if (next === "settings") {
      navigate({ type: "open-settings" });
      return;
    }
    if (next === "welcome" && project.data) {
      guardDirty("返回欢迎页", goWelcome);
      return;
    }
    if (isProjectView(next) && !project.data) return;
    navigate({ type: "show-content", page: next });
    if (isProjectView(next)) void window.testforge.settings.setProjectView(next);
  };

  const openSettings = () => navigate({ type: "open-settings" });
  const returnFromSettings = () => navigate({ type: "return-from-settings", hasProject: Boolean(project.data) });

  const handleProjectAction = (action: "save" | "open" | "welcome") => {
    if (action === "save") { save.mutate(); return; }
    if (action === "welcome") { guardDirty("返回欢迎页", goWelcome); return; }
    guardDirty("打开其他项目", async () => { await chooseAndOpen(); });
  };

  const continuePending = async (saveFirst: boolean) => {
    const pending = pendingAction;
    if (!pending) return;
    setError(undefined);
    try {
      if (saveFirst) {
        const document = await window.testforge.projects.save();
        await syncProject(document);
      }
      setPendingAction(undefined);
      await pending.run();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const initializeSelected = async () => {
    if (!pendingSelection) return;
    try {
      const document = await window.testforge.projects.initializeFolder(pendingSelection.rootPath);
      setPendingSelection(undefined);
      await enterProject(document.rootPath);
    } catch (reason) { setError(errorMessage(reason)); }
  };

  const currentProject = project.data ?? null;
  const busy = save.isPending;
  const taskList = wiringTasks.data ?? [];
  const occupancyRequestList = occupancyRequests.data ?? [];
  const hardwareList = catalog.data?.hardware ?? [];
  const pendingTasks = currentProject ? taskList.filter((task) => task.status === "pending") : [];
  const pendingOccupancyRequests = occupancyRequestList.filter((request) => request.status === "pending");
  const occupancyDecision = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "acquire" | "reject" }) => action === "acquire"
      ? window.testforge.occupancy.acquireRequest(id)
      : window.testforge.occupancy.rejectRequest(id, "人工拒绝了硬件占用请求"),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.occupancyRequests });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
    onError: (reason) => setError(errorMessage(reason))
  });
  const page = navigation.page;
  const goToWiringTasks = async () => {
    const nextTask = pendingTasks[0];
    switchPage("wiring");
    if (!nextTask) return;
    setError(undefined);
    try {
      await window.testforge.wiring.startTask(nextTask.wiringTaskId, "operator");
    } catch (reason) {
      const latest = await window.testforge.wiring.getTask(nextTask.wiringTaskId).catch(() => undefined);
      if (latest?.status !== "in_progress") setError(errorMessage(reason));
    } finally {
      await invalidateWiringData(client);
    }
  };
  return (
    <div className="app">
      <TitleBar page={page} projectView={navigation.projectView} project={currentProject} assistantOpen={assistantOpen} busy={busy} pendingTaskCount={pendingTasks.length + pendingOccupancyRequests.length} wiringLogOpen={wiringLogOpen} onToggleWiringLog={() => setWiringLogOpen((open) => !open)} onNavigate={switchPage} onProjectAction={handleProjectAction} onToggleAssistant={() => setAssistantOpen((open) => !open)} />
      <div className="app-body">
        <ErrorBoundary key={`content-${page}`}>
          <Suspense fallback={<FeatureFallback />}>
            {page === "welcome" ? <WelcomePage onOpened={enterProject} />
              : page === "settings" ? <SettingsPage dashboard={dashboard} theme={theme.choice} onThemeChange={theme.select} onBack={returnFromSettings} />
                : currentProject ? <ProjectWorkspace view={page as ProjectView} />
                  : <WelcomePage onOpened={enterProject} />}
          </Suspense>
        </ErrorBoundary>
        {page !== "welcome" && assistantOpen && currentProject && (
          <ErrorBoundary key={`assistant-${currentProject.rootPath}`} fallback={<aside className="assistant-sidebar"><section className="feature-error" role="alert">AI 助手暂时无法显示</section></aside>}>
            <Suspense fallback={<aside className="assistant-sidebar"><FeatureFallback /></aside>}>
              <AssistantSidebar gatewayRunning={dashboard.data?.gateway.running ?? false} onClose={() => setAssistantOpen(false)} onOpenSettings={openSettings} />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>
      {error && <div className="app-error" role="alert"><span>{error}</span><button aria-label="关闭错误" onClick={() => setError(undefined)}>×</button></div>}

      {wiringLogOpen && <MailboxDropdown tasks={currentProject ? taskList : []} occupancyRequests={occupancyRequestList} hardware={hardwareList} busyRequestId={occupancyDecision.isPending ? occupancyDecision.variables?.id : undefined} onOccupancyAction={(id, action) => occupancyDecision.mutate({ id, action })} onClose={() => setWiringLogOpen(false)} />}
      {!wiringLogOpen && pendingOccupancyRequests.length > 0 && <OccupancyAlertModal requests={pendingOccupancyRequests} busyRequestId={occupancyDecision.isPending ? occupancyDecision.variables?.id : undefined} onAction={(id, action) => occupancyDecision.mutate({ id, action })} />}
      {!wiringLogOpen && pendingOccupancyRequests.length === 0 && page !== "wiring" && pendingTasks.length > 0 && <WiringAlertModal tasks={pendingTasks} hardware={hardwareList} onGoWiring={() => void goToWiringTasks()} />}

      <Modal open={Boolean(pendingAction)} onClose={() => setPendingAction(undefined)} title="保存项目修改" footer={<><Btn onClick={() => setPendingAction(undefined)}>取消</Btn><Btn variant="danger" onClick={() => void continuePending(false)}>放弃修改</Btn><Btn variant="primary" onClick={() => void continuePending(true)}>保存并继续</Btn></>}>
        <p>当前项目有未保存的修改。要在{pendingAction?.label}前保存吗？</p>
      </Modal>
      <Modal open={Boolean(pendingSelection)} onClose={() => setPendingSelection(undefined)} title="初始化 TestForge 项目" footer={<><Btn onClick={() => setPendingSelection(undefined)}>取消</Btn><Btn variant="primary" onClick={() => void initializeSelected()}>创建并打开</Btn></>}>
        <p>文件夹 <strong>{pendingSelection?.name}</strong> 中还没有 <code>.testforge/project.json</code>。</p>
        <p className="form-note">继续只会创建项目清单，不会修改其他文件。</p>
      </Modal>
    </div>
  );
}

function FeatureFallback() { return <div className="centered"><Spinner label="正在加载功能…" /></div>; }
/** Global session mailbox, combining wiring tasks and hardware occupancy requests. */
function MailboxDropdown({ tasks, occupancyRequests, hardware, busyRequestId, onOccupancyAction, onClose }: {
  tasks: WiringTask[];
  occupancyRequests: HardwareOccupancyRequest[];
  hardware: Parameters<typeof taskTitle>[1];
  busyRequestId: string | undefined;
  onOccupancyAction: (id: string, action: "acquire" | "reject") => void;
  onClose: () => void;
}) {
  const items = [
    ...tasks.map((task) => ({ kind: "wiring" as const, requestedAt: task.requestedAt, task })),
    ...occupancyRequests.map((request) => ({ kind: "occupancy" as const, requestedAt: request.requestedAt, request }))
  ].sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  return (
    <div className="wiring-log-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="wiring-log-dropdown" role="dialog" aria-label="信箱">
        <header><strong>信箱</strong><span>{items.length} 条</span></header>
        <div className="wiring-log-dropdown-list">
          {items.map((item) => item.kind === "wiring" ? <div key={item.task.wiringTaskId} className="wiring-log-row">
              <span className={`badge badge-${taskTone(item.task.status)}`}>{item.task.status}</span>
              <span className="wiring-log-copy">
                <strong>接线 · {taskTitle(item.task, hardware)}</strong>
                <small>{item.task.message || (item.task.warnings.length ? item.task.warnings.join("；") : pinCountText(item.task))}</small>
              </span>
              <time>{new Date(item.task.requestedAt).toLocaleString()}</time>
            </div> : <div key={item.request.occupancyRequestId} className="wiring-log-row">
              <span className={`badge badge-${occupancyTone(item.request.status)}`}>{item.request.status}</span>
              <span className="wiring-log-copy">
                <strong>硬件占用 · {occupancyHardwareLabel(item.request, hardware)}</strong>
                <small>{item.request.message || item.request.reason || "AI 请求人工占用硬件"}</small>
                {item.request.status === "pending" && <span className="mailbox-actions">
                  <Btn variant="primary" disabled={busyRequestId === item.request.occupancyRequestId} onClick={() => onOccupancyAction(item.request.occupancyRequestId, "acquire")}>占用全部</Btn>
                  <Btn disabled={busyRequestId === item.request.occupancyRequestId} onClick={() => onOccupancyAction(item.request.occupancyRequestId, "reject")}>拒绝</Btn>
                </span>}
              </span>
              <time>{new Date(item.request.requestedAt).toLocaleString()}</time>
            </div>)}
          {!items.length && <div className="wiring-log-empty">信箱中暂无请求。</div>}
        </div>
      </section>
    </div>
  );
}

function OccupancyAlertModal({ requests, busyRequestId, onAction }: {
  requests: HardwareOccupancyRequest[];
  busyRequestId: string | undefined;
  onAction: (id: string, action: "acquire" | "reject") => void;
}) {
  return <Modal open onClose={() => undefined} title="AI 请求人工占用硬件" width={560}>
    <div className="wiring-alert-list">
      {requests.map((request) => <div key={request.occupancyRequestId} className="wiring-alert-item">
        <strong>{occupancyHardwareLabel(request, [])}</strong>
        <small>{request.reason || "AI 请求在操作前占用这些硬件。"}</small>
        {request.message && <small>{request.message}</small>}
        <span className="mailbox-actions">
          <Btn variant="primary" disabled={busyRequestId === request.occupancyRequestId} onClick={() => onAction(request.occupancyRequestId, "acquire")}>占用全部</Btn>
          <Btn disabled={busyRequestId === request.occupancyRequestId} onClick={() => onAction(request.occupancyRequestId, "reject")}>拒绝</Btn>
        </span>
      </div>)}
    </div>
    <p className="form-note">该操作必须由人类点击。任一硬件占用失败时，只回滚本次新获得的租约。</p>
  </Modal>;
}

function occupancyHardwareLabel(request: HardwareOccupancyRequest, hardware: Parameters<typeof taskTitle>[1]): string {
  return request.hardwareIds.map((hardwareId) => hardware.find((item) => item.hardwareId === hardwareId)?.label ?? hardwareId).join("、");
}

function occupancyTone(status: HardwareOccupancyRequest["status"]): ReturnType<typeof taskTone> {
  if (status === "confirmed") return "ok";
  if (status === "pending") return "warn";
  if (status === "rejected" || status === "failed" || status === "timed_out") return "bad";
  return "muted";
}

/** AI 请求人工接线时全局弹窗提醒，确认后跳到接线页处理。 */
function WiringAlertModal({ tasks, hardware, onGoWiring }: {
  tasks: WiringTask[]; hardware: Parameters<typeof taskTitle>[1]; onGoWiring: () => void;
}) {
  return (
    <Modal open onClose={onGoWiring} title="AI 请求人工接线" width={520}
      footer={<Btn variant="primary" onClick={onGoWiring}>前往处理</Btn>}>
      <div className="wiring-alert-list">
        {tasks.map((task) => <div key={task.wiringTaskId} className="wiring-alert-item">
          <strong>{taskTitle(task, hardware)}</strong>
          <small>{pinCountText(task)}</small>
          {task.message && <small>{task.message}</small>}
          {task.warnings.map((warning) => <small key={warning}>⚠ {warning}</small>)}
        </div>)}
      </div>
      <p className="form-note">请在工位接线页确认完成后，AI 流程才会继续。</p>
    </Modal>
  );
}
