import { lazy, Suspense, useCallback, useEffect, useReducer, useState } from "react";
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectDocument, ProjectFolderSelection } from "@teststand/contracts/projects";
import { ToastProvider, TooltipProvider, useToast } from "../ui";
import { useDashboard, useProjectDocument } from "../lib/queries.js";
import { useTheme } from "../lib/theme.js";
import { errorMessage } from "../lib/errors.js";
import { queryKeys } from "../lib/query-keys.js";
import { REOPEN_AFTER_RELAUNCH } from "../lib/host/api.js";
import { useTestStandEvents } from "../lib/hooks/useTestStandEvents.js";
import { useKeyboardShortcut } from "../lib/hooks/useKeyboardShortcut.js";
import { useDirtyGuard } from "../lib/hooks/useDirtyGuard.js";
import { chooseProjectFolder } from "../lib/projects.js";
import { onRunRequested } from "../lib/run-focus.js";
import { onSidePanelRequested, type SidePanel } from "../lib/side-panel.js";
import { ManualCheckDialog } from "../features/testing/ManualCheckDialog.js";
import { ActivityBar } from "./ActivityBar.js";
import { appNavigationReducer, initialAppNavigation, type AppPage } from "./app-navigation.js";
import { readAssistantOpen, writeAssistantOpen } from "./assistant-preference.js";
import { AgentConfirmationDialog } from "./AgentConfirmationDialog.js";
import { DirtyDialog } from "./DirtyDialog.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { FeatureFallback } from "./FeatureFallback.js";
import { InitializeDialog } from "./InitializeDialog.js";
import { TitleBar, type ProjectAction } from "./TitleBar.js";

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
  const [navigation, navigate] = useReducer(appNavigationReducer, initialAppNavigation);
  const [assistantOpen, setAssistantOpen] = useState(readAssistantOpen);
  const [panel, setPanel] = useState<SidePanel | undefined>("devices");
  const [pendingSelection, setPendingSelection] = useState<ProjectFolderSelection>();
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
  useEffect(() => { writeAssistantOpen(assistantOpen); }, [assistantOpen]);
  useEffect(() => { if (!project.data) setAssistantOpen(false); }, [project.data]);
  useEffect(() => {
    if (!project.data) return;
    const stopPanels = onSidePanelRequested((next) => {
      navigate({ type: "show-content", page: "bench" });
      setPanel(next);
    });
    // The operator started a run: watch it on the bench's signal view, which is already watching.
    const stopRuns = onRunRequested(() => navigate({ type: "show-content", page: "bench" }));
    return () => {
      stopPanels();
      stopRuns();
    };
  }, [project.data]);

  const enterProject = useCallback(async () => {
    await syncProject();
    navigate({ type: "show-content", page: "bench" });
    setAssistantOpen(readAssistantOpen());
  }, [syncProject]);

  // After 重启 testStand (a driver update), open the project the restart left.
  useEffect(() => {
    const rootPath = localStorage.getItem(REOPEN_AFTER_RELAUNCH);
    if (!rootPath) return;
    localStorage.removeItem(REOPEN_AFTER_RELAUNCH);
    void window.teststand.projects.openFolder({ rootPath })
      .then(() => enterProject())
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, [enterProject, setError]);

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

  const openSettings = () => {
    if (navigation.page === "settings" || beforeNavigation({ next: "settings" })) navigate({ type: "open-settings" });
  };
  const returnFromSettings = () => navigate({ type: "return-from-settings", hasProject: Boolean(project.data) });
  /** An activity bar icon: show its panel, or fold the sidebar away when it is the one shown. */
  const togglePanel = (next: SidePanel) => {
    if (navigation.page === "settings") {
      returnFromSettings();
      setPanel(next);
      return;
    }
    setPanel((current) => current === next ? undefined : next);
  };

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
  const page: AppPage = navigation.page;

  return (
    <div className="flex h-full flex-col bg-surface-0 text-fg">
      <TitleBar
        page={page}
        project={currentProject}
        assistantOpen={assistantOpen}
        busy={save.isPending}
        onProjectAction={handleProjectAction}
        onToggleAssistant={() => setAssistantOpen((open) => !open)}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ActivityBar
          panel={panel}
          inProject={page !== "welcome" && Boolean(currentProject)}
          settingsOpen={page === "settings"}
          theme={theme.resolved}
          onPanel={togglePanel}
          onSettings={() => (page === "settings" ? returnFromSettings() : openSettings())}
          onToggleTheme={() => void theme.select(theme.resolved === "dark" ? "light" : "dark")}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* One boundary per open project: switching its pages must not remount them. */}
          <ErrorBoundary key={page === "bench" ? `project-${currentProject?.rootPath}` : `content-${page}`}>
            <Suspense fallback={<FeatureFallback />}>
              {page === "settings"
                ? <SettingsPage
                    dashboard={dashboard}
                    theme={theme.choice}
                    onThemeChange={theme.select}
                    onBack={returnFromSettings}
                  />
                : page !== "welcome" && currentProject
                  ? <ProjectWorkspace panel={panel} />
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
