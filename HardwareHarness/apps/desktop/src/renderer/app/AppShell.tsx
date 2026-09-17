import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectDocument, ProjectFolderSelection } from "@hardwareharness/contracts/projects";
import type { ProjectView } from "@hardwareharness/contracts/storage";
import { Spinner } from "../shared/ui/skeleton";
import { ToastProvider, useToast } from "../shared/ui/toast";
import { useDashboard, useDeviceCatalog, useProjectDocument, useWiringTasks } from "../shared/queries.js";
import { useTheme } from "../shared/theme.js";
import { ErrorBoundary } from "../shared/ErrorBoundary.js";
import { errorMessage } from "../shared/errors.js";
import { queryKeys } from "../shared/query-keys.js";
import { useHardwareHarnessEvents } from "../shared/hooks/useHardwareHarnessEvents.js";
import { useKeyboardShortcut } from "../shared/hooks/useKeyboardShortcut.js";
import { useDirtyGuard } from "../shared/hooks/useDirtyGuard.js";
import { appNavigationReducer, initialAppNavigation, isProjectView, type AppPage } from "./app-navigation.js";
import { readAssistantOpen, writeAssistantOpen } from "./assistant-preference.js";
import { TitleBar } from "./TitleBar.js";
import { WiringTaskInbox } from "./WiringTaskInbox.js";
import { isTaskActionable } from "../features/wiring/wiring-model.js";
import { DirtyDialog } from "./DirtyDialog.js";
import { InitializeDialog } from "./InitializeDialog.js";
import { useReducer } from "react";

const AssistantSidebar = lazy(() => import("../features/agent/assistant.js").then((module) => ({ default: module.AssistantSidebar })));
const ProjectWorkspace = lazy(() => import("../features/projects/ProjectWorkspace.js").then((module) => ({ default: module.ProjectWorkspace })));
const WelcomePage = lazy(() => import("../features/projects/WelcomePage.js").then((module) => ({ default: module.WelcomePage })));
const SettingsPage = lazy(() => import("../features/settings/SettingsPage.js").then((module) => ({ default: module.SettingsPage })));

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

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
  const [pendingSelection, setPendingSelection] = useState<ProjectFolderSelection>();
  const [wiringLogOpen, setWiringLogOpen] = useState(false);
  const toast = useToast();
  const setError = useCallback((message?: string) => { if (message) toast.error(message); }, [toast]);

  const wiringTasks = useWiringTasks();
  const catalog = useDeviceCatalog();

  useHardwareHarnessEvents(client);

  const syncProject = useCallback(async (document?: ProjectDocument | null) => {
    if (document !== undefined) client.setQueryData(queryKeys.projectDocument, document);
    else await client.invalidateQueries({ queryKey: queryKeys.projectDocument });
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.recentProjects }),
      client.invalidateQueries({ queryKey: queryKeys.wiringTasks }),
      client.invalidateQueries({ queryKey: queryKeys.openCodeStatus })
    ]);
  }, [client]);

  const save = useMutation({
    mutationFn: () => window.hardwareharness.projects.save(),
    onSuccess: (document) => void syncProject(document),
    onError: (reason) => setError(errorMessage(reason))
  });

  const dirtyGuard = useDirtyGuard(
    Boolean(project.data?.dirty),
    () => window.hardwareharness.projects.save(),
    syncProject,
    (message) => setError(message),
  );

  useKeyboardShortcut("s", save.mutateAsync, Boolean(project.data));
  useEffect(() => { writeAssistantOpen(assistantOpen); }, [assistantOpen]);
  useEffect(() => { if (!project.data) setAssistantOpen(false); }, [project.data]);
  useEffect(() => {
    const openPlans = () => { if (project.data) { navigate({ type: "show-content", page: "plans" }); void window.hardwareharness.settings.setProjectView("plans"); } };
    window.addEventListener("hardwareharness:navigate-plans", openPlans);
    return () => window.removeEventListener("hardwareharness:navigate-plans", openPlans);
  }, [project.data]);

  const enterProject = useCallback(async (rootPath: string) => {
    await syncProject();
    const savedView = await window.hardwareharness.settings.getProjectView();
    navigate({ type: "enter-project", view: savedView });
    setAssistantOpen(readAssistantOpen());
    setError(undefined);
    void rootPath;
  }, [syncProject, setError]);

  const goWelcome = useCallback(async () => {
    await window.hardwareharness.projects.leave();
    await syncProject(null);
    setAssistantOpen(false);
    navigate({ type: "show-content", page: "welcome" });
  }, [syncProject]);

  const chooseAndOpen = useCallback(async () => {
    const selection = await window.hardwareharness.projects.chooseFolder();
    if (!selection) return;
    if (selection.state === "invalid") throw new Error(selection.message ?? "项目清单无法读取。");
    if (selection.state === "uninitialized") { setPendingSelection(selection); return; }
    const document = await window.hardwareharness.projects.openFolder(selection.rootPath);
    await enterProject(document.rootPath);
  }, [enterProject]);

  const switchPage = (next: AppPage) => {
    if (!window.dispatchEvent(new CustomEvent("hardwareharness:before-navigation", { cancelable: true, detail: { next } }))) return;
    if (next === "settings") { navigate({ type: "open-settings" }); return; }
    if (next === "welcome" && project.data) { dirtyGuard.guard("返回欢迎页", goWelcome); return; }
    if (isProjectView(next) && !project.data) return;
    navigate({ type: "show-content", page: next });
    if (isProjectView(next)) void window.hardwareharness.settings.setProjectView(next);
  };

  const openSettings = () => navigate({ type: "open-settings" });
  const returnFromSettings = () => navigate({ type: "return-from-settings", hasProject: Boolean(project.data) });

  const handleProjectAction = (action: "save" | "open" | "welcome") => {
    if (action !== "save" && !window.dispatchEvent(new CustomEvent("hardwareharness:before-navigation", { cancelable: true, detail: { action } }))) return;
    if (action === "save") { save.mutate(); return; }
    if (action === "welcome") { dirtyGuard.guard("返回欢迎页", goWelcome); return; }
    dirtyGuard.guard("打开其他项目", async () => { await chooseAndOpen(); });
  };

  const initializeSelected = async () => {
    if (!pendingSelection) return;
    try {
      const document = await window.hardwareharness.projects.initializeFolder(pendingSelection.rootPath);
      setPendingSelection(undefined);
      await enterProject(document.rootPath);
    } catch (reason) { setError(errorMessage(reason)); }
  };

  const currentProject = project.data ?? null;
  const busy = save.isPending;
  const taskList = wiringTasks.data ?? [];
  const hardwareList = catalog.data?.hardware ?? [];
  const pendingTasks = currentProject ? taskList.filter(isTaskActionable) : [];

  const page = navigation.page;

  return (
    <div className="flex h-full flex-col">
      <TitleBar
        page={page}
        projectView={navigation.projectView}
        project={currentProject}
        assistantOpen={assistantOpen}
        busy={busy}
        pendingTaskCount={pendingTasks.length}
        wiringLogOpen={wiringLogOpen}
        onToggleWiringLog={() => setWiringLogOpen((open) => !open)}
        onNavigate={switchPage}
        onProjectAction={handleProjectAction}
        onToggleAssistant={() => setAssistantOpen((open) => !open)}
      />
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
          <ErrorBoundary key={`assistant-${currentProject.rootPath}`} fallback={<aside className="tf-agent-sidebar animate-slide-in-right"><section role="alert" className="grid h-full place-content-center justify-items-center gap-2 p-8 text-center text-muted-foreground">AI 助手暂时无法显示</section></aside>}>
            <Suspense fallback={<aside className="tf-agent-sidebar animate-slide-in-right"><FeatureFallback /></aside>}>
              <AssistantSidebar gatewayRunning={dashboard.data?.gateway.running ?? false} onClose={() => setAssistantOpen(false)} onOpenSettings={openSettings} />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>

      <WiringTaskInbox
          key={currentProject?.rootPath ?? "no-project"}
          tasks={currentProject ? taskList : []}
          hardware={hardwareList}
          mailboxOpen={wiringLogOpen}
          onCloseMailbox={() => setWiringLogOpen(false)}
        />

      <DirtyDialog
        pending={dirtyGuard.pending}
        onContinue={(saveFirst) => void dirtyGuard.continuePending(saveFirst)}
        onCancel={dirtyGuard.clearPending}
      />
      <InitializeDialog
        selection={pendingSelection}
        busy={false}
        onConfirm={() => void initializeSelected()}
        onCancel={() => setPendingSelection(undefined)}
      />
    </div>
  );
}

function FeatureFallback() {
  return <div className="grid min-h-[60vh] flex-1 place-items-center"><Spinner label="正在加载功能…" /></div>;
}
