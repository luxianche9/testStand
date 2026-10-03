import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectDocument, ProjectFolderSelection } from "@teststand/contracts/projects";
import type { ProjectView } from "@teststand/contracts/storage";
import { ToastProvider, TooltipProvider, useToast } from "../ui";
import { useDashboard, useProjectDocument, useWiringTasks } from "../lib/queries.js";
import { useTheme } from "../lib/theme.js";
import { errorMessage } from "../lib/errors.js";
import { queryKeys } from "../lib/query-keys.js";
import { useTestStandEvents } from "../lib/hooks/useTestStandEvents.js";
import { useKeyboardShortcut } from "../lib/hooks/useKeyboardShortcut.js";
import { useDirtyGuard } from "../lib/hooks/useDirtyGuard.js";
import { chooseProjectFolder } from "../lib/projects.js";
import { onRunRequested } from "../lib/run-focus.js";
import { isTaskActionable } from "../features/wiring/wiring-model.js";
import { ManualCheckDialog } from "../features/testing/ManualCheckDialog.js";
import { appNavigationReducer, initialAppNavigation, isProjectView, type AppPage } from "./app-navigation.js";
import { readAssistantOpen, writeAssistantOpen } from "./assistant-preference.js";
import { dispatchAppCommand } from "./commands.js";
import { CommandPalette, paletteIcons, type PaletteCommand } from "./CommandPalette.js";
import { AgentConfirmationDialog } from "./AgentConfirmationDialog.js";
import { DirtyDialog } from "./DirtyDialog.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { FeatureFallback } from "./FeatureFallback.js";
import { InitializeDialog } from "./InitializeDialog.js";
import { TitleBar, PROJECT_VIEWS, type ProjectAction } from "./TitleBar.js";

const AssistantSidebar = lazy(() => import("../features/agent/assistant.js")
  .then((module) => ({ default: module.AssistantSidebar })));
const ProjectWorkspace = lazy(() => import("../features/projects/ProjectWorkspace.js")
  .then((module) => ({ default: module.ProjectWorkspace })));
const WelcomePage = lazy(() => import("../features/projects/WelcomePage.js")
  .then((module) => ({ default: module.WelcomePage })));
const SettingsPage = lazy(() => import("../features/settings/SettingsPage.js")
  .then((module) => ({ default: module.SettingsPage })));

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function beforeNavigation(detail: Record<string, unknown>) {
  return window.dispatchEvent(new CustomEvent("teststand:before-navigation", { cancelable: true, detail }));
}

function Shell() {
  const client = useQueryClient();
  const theme = useTheme();
  const dashboard = useDashboard();
  const project = useProjectDocument();
  const wiringTasks = useWiringTasks();
  const [navigation, navigate] = useReducer(appNavigationReducer, initialAppNavigation);
  const [assistantOpen, setAssistantOpen] = useState(readAssistantOpen);
  const [pendingSelection, setPendingSelection] = useState<ProjectFolderSelection>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const toast = useToast();
  const setError = useCallback((message?: string) => { if (message) toast.error(message); }, [toast]);

  useTestStandEvents(client);

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
    mutationFn: () => window.teststand.projects.saveProject(),
    onSuccess: (document) => void syncProject(document),
    onError: (reason) => setError(errorMessage(reason))
  });

  const dirtyGuard = useDirtyGuard(
    Boolean(project.data?.dirty),
    () => window.teststand.projects.saveProject(),
    syncProject,
    (message) => setError(message)
  );

  useKeyboardShortcut("s", save.mutateAsync, Boolean(project.data));
  useKeyboardShortcut("k", () => setPaletteOpen((open) => !open));
  useEffect(() => { writeAssistantOpen(assistantOpen); }, [assistantOpen]);
  useEffect(() => { if (!project.data) setAssistantOpen(false); }, [project.data]);
  useEffect(() => {
    const openPlans = () => {
      if (!project.data) return;
      navigate({ type: "show-content", page: "plans" });
      void window.teststand.settings.update({ projectView: "plans" });
    };
    window.addEventListener("teststand:navigate-plans", openPlans);
    // A run started (here or by an agent): watch it on 运行监控.
    const stopRuns = onRunRequested(() => {
      if (project.data) navigate({ type: "show-content", page: "runs" });
    });
    return () => {
      window.removeEventListener("teststand:navigate-plans", openPlans);
      stopRuns();
    };
  }, [project.data]);

  const enterProject = useCallback(async () => {
    await syncProject();
    const savedView = (await window.teststand.settings.get()).projectView;
    navigate({ type: "enter-project", view: savedView });
    setAssistantOpen(readAssistantOpen());
  }, [syncProject]);

  const goWelcome = useCallback(async () => {
    await window.teststand.projects.leaveProject();
    await syncProject(null);
    setAssistantOpen(false);
    navigate({ type: "show-content", page: "welcome" });
  }, [syncProject]);

  const chooseAndOpen = useCallback(async () => {
    const selection = await chooseProjectFolder();
    if (!selection) return;
    if (selection.state === "invalid") throw new Error(selection.message ?? "项目清单无法读取。");
    if (selection.state === "uninitialized") { setPendingSelection(selection); return; }
    await window.teststand.projects.openFolder({ rootPath: selection.rootPath });
    await enterProject();
  }, [enterProject]);

  const switchPage = (next: AppPage) => {
    if (!beforeNavigation({ next })) return;
    if (next === "settings") { navigate({ type: "open-settings" }); return; }
    if (next === "welcome" && project.data) { dirtyGuard.guard("返回欢迎页", goWelcome); return; }
    if (isProjectView(next) && !project.data) return;
    navigate({ type: "show-content", page: next });
    if (isProjectView(next)) void window.teststand.settings.update({ projectView: next });
  };

  const openSettings = () => navigate({ type: "open-settings" });
  const returnFromSettings = () => navigate({ type: "return-from-settings", hasProject: Boolean(project.data) });

  const handleProjectAction = (action: ProjectAction) => {
    if (action !== "save" && !beforeNavigation({ action })) return;
    if (action === "save") { save.mutate(); return; }
    if (action === "welcome") { dirtyGuard.guard("返回欢迎页", goWelcome); return; }
    dirtyGuard.guard("打开其他项目", async () => {
      try { await chooseAndOpen(); } catch (reason) { setError(errorMessage(reason)); }
    });
  };

  const initializeSelected = async () => {
    if (!pendingSelection) return;
    try {
      await window.teststand.projects.initializeFolder({ rootPath: pendingSelection.rootPath });
      setPendingSelection(undefined);
      await enterProject();
    } catch (reason) { setError(errorMessage(reason)); }
  };

  const currentProject = project.data ?? null;
  const taskList = wiringTasks.data ?? [];
  const pendingTasks = currentProject ? taskList.filter(isTaskActionable) : [];
  const pendingKey = pendingTasks.map((task) => task.wiringTaskId).join(",");
  // A wiring request is answered in the conversation card, so make sure the conversation is on screen.
  useEffect(() => { if (pendingKey) setAssistantOpen(true); }, [pendingKey]);
  const page = navigation.page;

  const runCommand = (id: Parameters<typeof dispatchAppCommand>[0], view: ProjectView) => {
    if (page !== view) switchPage(view);
    // Give the lazily loaded page a frame to mount its command listeners.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!dispatchAppCommand(id)) toast.info("该页面暂时无法执行此命令");
    }));
  };

  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [];
    if (currentProject) {
      for (const view of PROJECT_VIEWS) {
        list.push({
          id: `go-${view.view}`, label: `前往 ${view.label}`, group: "页面",
          icon: paletteIcons[view.view], run: () => switchPage(view.view)
        });
      }
    }
    list.push({ id: "go-settings", label: "打开设置", group: "页面", icon: paletteIcons.settings, run: openSettings });
    if (currentProject) {
      list.push(
        { id: "test-run-selected", label: "运行所选测试项", group: "测试编排", icon: paletteIcons.run,
          keywords: "run test", run: () => runCommand("testing.run-selected", "plans") },
        { id: "test-new-item", label: "新建测试项", group: "测试编排", icon: paletteIcons.add,
          keywords: "new test item", run: () => runCommand("testing.new-item", "plans") },
        { id: "wiring-new", label: "新建接线", group: "工位接线", icon: paletteIcons.add,
          keywords: "connection wire", run: () => runCommand("wiring.new-connection", "wiring") }
      );
    }
    list.push({ id: "project-open", label: "打开项目文件夹…", group: "项目", icon: paletteIcons.open,
      run: () => handleProjectAction("open") });
    if (currentProject) {
      list.push(
        { id: "project-save", label: "保存项目", group: "项目", icon: paletteIcons.save, shortcut: "Ctrl S",
          run: () => handleProjectAction("save") },
        { id: "toggle-ai", label: assistantOpen ? "关闭 AI 助手" : "打开 AI 助手", group: "视图",
          icon: paletteIcons.ai, keywords: "assistant agent", run: () => setAssistantOpen((open) => !open) }
      );
    }
    list.push(
      { id: "theme-dark", label: "切换到深色主题", group: "视图", icon: paletteIcons.dark,
        keywords: "theme dark", run: () => void theme.select("dark") },
      { id: "theme-light", label: "切换到浅色主题", group: "视图", icon: paletteIcons.light,
        keywords: "theme light", run: () => void theme.select("light") }
    );
    return list;
  // The command closures read the latest render state; rebuilding on these inputs is sufficient.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject, assistantOpen, page, theme.choice]);

  return (
    <div className="flex h-full flex-col bg-surface-0 text-fg">
      <TitleBar
        page={page}
        projectView={navigation.projectView}
        project={currentProject}
        assistantOpen={assistantOpen}
        busy={save.isPending}
        pendingTaskCount={pendingTasks.length}
        onNavigate={switchPage}
        onProjectAction={handleProjectAction}
        onToggleAssistant={() => setAssistantOpen((open) => !open)}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ErrorBoundary key={`content-${page}`}>
            <Suspense fallback={<FeatureFallback />}>
              {page === "settings"
                ? <SettingsPage
                    dashboard={dashboard}
                    theme={theme.choice}
                    onThemeChange={theme.select}
                    onBack={returnFromSettings}
                  />
                : page !== "welcome" && currentProject
                  ? <ProjectWorkspace view={page as ProjectView} />
                  : <WelcomePage onOpened={() => enterProject()} />}
            </Suspense>
          </ErrorBoundary>
        </main>
        {page !== "welcome" && assistantOpen && currentProject && (
          <ErrorBoundary key={`assistant-${currentProject.rootPath}`} fallback={<AssistantUnavailable />}>
            <Suspense fallback={<aside className="tf-agent-sidebar animate-slide-in-right"><FeatureFallback /></aside>}>
              <AssistantSidebar
                gatewayRunning={dashboard.data?.gateway.running ?? false}
                onClose={() => setAssistantOpen(false)}
                onOpenSettings={openSettings}
              />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      <AgentConfirmationDialog />
      <ManualCheckDialog />
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

function AssistantUnavailable() {
  return (
    <aside className="tf-agent-sidebar animate-slide-in-right">
      <section role="alert" className="grid h-full place-content-center gap-2 p-8 text-center text-sm text-fg-3">
        AI 助手暂时无法显示
      </section>
    </aside>
  );
}
