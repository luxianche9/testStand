import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectDocument, ProjectFolderSelection } from "@testforge/contracts/projects";
import type { WiringTask } from "@testforge/contracts/wiring";
import type { HardwareOccupancyRequest } from "@testforge/contracts/occupancy";
import { Spinner } from "../shared/ui/skeleton";
import { Badge, badgeVariantFromTone } from "../shared/ui/badge";
import { Button } from "../shared/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../shared/ui/dialog";
import { ToastProvider, useToast } from "../shared/ui/toast";
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
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </QueryClientProvider>
  );
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
  const toast = useToast();
  const setError = useCallback((message?: string) => { if (message) toast.error(message); }, [toast]);
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
  }, [syncProject, setError]);

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
    <div className="flex h-full flex-col">
      <TitleBar page={page} projectView={navigation.projectView} project={currentProject} assistantOpen={assistantOpen} busy={busy} pendingTaskCount={pendingTasks.length + pendingOccupancyRequests.length} wiringLogOpen={wiringLogOpen} onToggleWiringLog={() => setWiringLogOpen((open) => !open)} onNavigate={switchPage} onProjectAction={handleProjectAction} onToggleAssistant={() => setAssistantOpen((open) => !open)} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ErrorBoundary key={`content-${page}`}>
          <Suspense fallback={<FeatureFallback />}>
            {page === "welcome" ? <WelcomePage onOpened={enterProject} />
              : page === "settings" ? <SettingsPage dashboard={dashboard} theme={theme.choice} onThemeChange={theme.select} onBack={returnFromSettings} />
                : currentProject ? <ProjectWorkspace view={page as ProjectView} />
                  : <WelcomePage onOpened={enterProject} />}
          </Suspense>
        </ErrorBoundary>
        {page !== "welcome" && assistantOpen && currentProject && (
          <ErrorBoundary key={`assistant-${currentProject.rootPath}`} fallback={<aside className="tf-agent-sidebar"><section role="alert" className="grid h-full place-content-center justify-items-center gap-2 p-8 text-center text-muted-foreground">AI 助手暂时无法显示</section></aside>}>
            <Suspense fallback={<aside className="tf-agent-sidebar"><FeatureFallback /></aside>}>
              <AssistantSidebar gatewayRunning={dashboard.data?.gateway.running ?? false} onClose={() => setAssistantOpen(false)} onOpenSettings={openSettings} />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>
      {wiringLogOpen && <MailboxDropdown tasks={currentProject ? taskList : []} occupancyRequests={occupancyRequestList} hardware={hardwareList} busyRequestId={occupancyDecision.isPending ? occupancyDecision.variables?.id : undefined} onOccupancyAction={(id, action) => occupancyDecision.mutate({ id, action })} onClose={() => setWiringLogOpen(false)} />}
      {!wiringLogOpen && pendingOccupancyRequests.length > 0 && <OccupancyAlertModal requests={pendingOccupancyRequests} busyRequestId={occupancyDecision.isPending ? occupancyDecision.variables?.id : undefined} onAction={(id, action) => occupancyDecision.mutate({ id, action })} />}
      {!wiringLogOpen && pendingOccupancyRequests.length === 0 && page !== "wiring" && pendingTasks.length > 0 && <WiringAlertModal tasks={pendingTasks} hardware={hardwareList} onGoWiring={() => void goToWiringTasks()} />}

      <Dialog open={Boolean(pendingAction)} onOpenChange={(open) => { if (!open) setPendingAction(undefined); }}>
        <DialogContent size="sm">
          <DialogHeader title="保存项目修改" />
          <DialogBody>
            <p className="m-0 text-sm">当前项目有未保存的修改。要在{pendingAction?.label}前保存吗？</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(undefined)}>取消</Button>
            <Button variant="destructive" onClick={() => void continuePending(false)}>放弃修改</Button>
            <Button onClick={() => void continuePending(true)}>保存并继续</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(pendingSelection)} onOpenChange={(open) => { if (!open) setPendingSelection(undefined); }}>
        <DialogContent size="sm">
          <DialogHeader title="初始化 TestForge 项目" />
          <DialogBody>
            <p className="m-0 text-sm">文件夹 <strong>{pendingSelection?.name}</strong> 中还没有 <code>.testforge/project.json</code>。</p>
            <p className="mt-2 mb-0 text-xs text-muted-foreground">继续只会创建项目清单，不会修改其他文件。</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingSelection(undefined)}>取消</Button>
            <Button onClick={() => void initializeSelected()}>创建并打开</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FeatureFallback() { return <div className="grid min-h-[60vh] flex-1 place-items-center"><Spinner label="正在加载功能…" /></div>; }
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
    <div className="fixed inset-0 z-[60]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-label="信箱" className="absolute top-[46px] right-3 grid max-h-[60vh] w-[420px] max-w-[calc(100vw-24px)] animate-fade-in grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border bg-popover shadow-2xl">
        <header className="flex items-center justify-between border-b px-3.5 py-2.5 text-sm font-medium">
          信箱<span className="text-xs font-normal text-muted-foreground">{items.length} 条</span>
        </header>
        <div className="grid content-start gap-0.5 overflow-y-auto p-1.5">
          {items.map((item) => item.kind === "wiring" ? (
            <div key={item.task.wiringTaskId} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent">
              <Badge variant={badgeVariantFromTone(taskTone(item.task.status))}>{item.task.status}</Badge>
              <span className="grid min-w-0">
                <strong className="truncate text-sm font-medium">接线 · {taskTitle(item.task, hardware)}</strong>
                <small className="truncate text-xs text-muted-foreground">{item.task.message || (item.task.warnings.length ? item.task.warnings.join("；") : pinCountText(item.task))}</small>
              </span>
              <time className="text-[11px] whitespace-nowrap text-muted-foreground">{new Date(item.task.requestedAt).toLocaleString()}</time>
            </div>
          ) : (
            <div key={item.request.occupancyRequestId} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent">
              <Badge variant={badgeVariantFromTone(occupancyTone(item.request.status))}>{item.request.status}</Badge>
              <span className="grid min-w-0">
                <strong className="truncate text-sm font-medium">硬件占用 · {occupancyHardwareLabel(item.request, hardware)}</strong>
                <small className="truncate text-xs text-muted-foreground">{item.request.message || item.request.reason || "AI 请求人工占用硬件"}</small>
                {item.request.status === "pending" && (
                  <span className="mt-1.5 flex gap-1.5">
                    <Button size="xs" disabled={busyRequestId === item.request.occupancyRequestId} onClick={() => onOccupancyAction(item.request.occupancyRequestId, "acquire")}>占用全部</Button>
                    <Button size="xs" variant="outline" disabled={busyRequestId === item.request.occupancyRequestId} onClick={() => onOccupancyAction(item.request.occupancyRequestId, "reject")}>拒绝</Button>
                  </span>
                )}
              </span>
              <time className="text-[11px] whitespace-nowrap text-muted-foreground">{new Date(item.request.requestedAt).toLocaleString()}</time>
            </div>
          ))}
          {!items.length && <div className="py-6 text-center text-sm text-muted-foreground">信箱中暂无请求。</div>}
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
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent>
        <DialogHeader title="AI 请求人工占用硬件" />
        <DialogBody>
          <div className="grid gap-2.5">
            {requests.map((request) => (
              <div key={request.occupancyRequestId} className="grid gap-1 rounded-md border bg-secondary/50 px-3 py-2.5">
                <strong className="text-sm">{occupancyHardwareLabel(request, [])}</strong>
                <small className="text-xs text-muted-foreground">{request.reason || "AI 请求在操作前占用这些硬件。"}</small>
                {request.message && <small className="text-xs text-muted-foreground">{request.message}</small>}
                <span className="mt-1.5 flex gap-1.5">
                  <Button size="xs" disabled={busyRequestId === request.occupancyRequestId} onClick={() => onAction(request.occupancyRequestId, "acquire")}>占用全部</Button>
                  <Button size="xs" variant="outline" disabled={busyRequestId === request.occupancyRequestId} onClick={() => onAction(request.occupancyRequestId, "reject")}>拒绝</Button>
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 mb-0 text-xs text-muted-foreground">该操作必须由人类点击。任一硬件占用失败时，只回滚本次新获得的租约。</p>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
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
    <Dialog open onOpenChange={(open) => { if (!open) onGoWiring(); }}>
      <DialogContent>
        <DialogHeader title="AI 请求人工接线" />
        <DialogBody>
          <div className="grid gap-2.5">
            {tasks.map((task) => (
              <div key={task.wiringTaskId} className="grid gap-1 rounded-md border bg-secondary/50 px-3 py-2.5">
                <strong className="text-sm">{taskTitle(task, hardware)}</strong>
                <small className="text-xs text-muted-foreground">{pinCountText(task)}</small>
                {task.message && <small className="text-xs text-muted-foreground">{task.message}</small>}
                {task.warnings.map((warning) => <small key={warning} className="text-xs text-warning">⚠ {warning}</small>)}
              </div>
            ))}
          </div>
          <p className="mt-3 mb-0 text-xs text-muted-foreground">请在工位接线页确认完成后，AI 流程才会继续。</p>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onGoWiring}>前往处理</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
