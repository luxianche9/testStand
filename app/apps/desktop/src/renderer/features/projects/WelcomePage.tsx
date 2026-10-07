import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import "@xyflow/react/dist/style.css";
import type { ProjectFolderSelection } from "@teststand/contracts/projects";
import type { WelcomeLayout } from "@teststand/contracts/storage";
import { CircleAlertIcon, FolderOpenIcon, Grid2X2Icon, ListIcon, ServerIcon } from "lucide-react";
import { InitializeDialog } from "../../app/InitializeDialog.js";
import { errorMessage } from "../../lib/errors.js";
import { chooseProjectFolder } from "../../lib/projects.js";
import { useRecentProjects } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import {
  Button,
  EmptyState,
  Panel,
  PanelBody,
  PanelHeader,
  SegmentedControl,
  Spinner,
  cn
} from "../../ui";
import { RecentProjectList } from "./RecentProjects.js";

const layoutOptions = [
  { value: "grid", title: "卡片布局", label: <LayoutOption icon={<Grid2X2Icon />} label="卡片布局" /> },
  { value: "list", title: "列表布局", label: <LayoutOption icon={<ListIcon />} label="列表布局" /> }
] as const;

export function WelcomePage({ onOpened }: { onOpened: (rootPath: string) => Promise<void> | void }) {
  const client = useQueryClient();
  const recent = useRecentProjects();
  const [layout, setLayout] = useState<WelcomeLayout>("grid");
  const [selection, setSelection] = useState<ProjectFolderSelection>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void window.teststand.settings.get().then((settings) => setLayout(settings.welcomeLayout));
  }, []);

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
    await window.teststand.projects.openFolder({ rootPath: next.rootPath });
    await onOpened(next.rootPath);
  };

  const choose = useMutation({
    mutationFn: () => chooseProjectFolder(),
    onSuccess: async (next) => { if (next) await openSelection(next); },
    onError: (reason) => setError(errorMessage(reason))
  });
  const initialize = useMutation({
    mutationFn: async () => {
      if (!selection) return null;
      return await window.teststand.projects.initializeFolder({ rootPath: selection.rootPath });
    },
    onSuccess: async (document) => {
      if (!document) return;
      setSelection(undefined);
      await onOpened(document.rootPath);
    },
    onError: (reason) => setError(errorMessage(reason))
  });
  const openRecent = useMutation({
    mutationFn: (rootPath: string) => window.teststand.projects.openFolder({ rootPath }),
    onSuccess: async (document) => { await onOpened(document.rootPath); },
    onError: (reason) => setError(errorMessage(reason))
  });
  const forget = useMutation({
    mutationFn: (rootPath: string) => window.teststand.projects.forgetRecent({ rootPath }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: queryKeys.recentProjects }); },
    onError: (reason) => setError(errorMessage(reason))
  });

  const changeLayout = (next: WelcomeLayout) => {
    setLayout(next);
    void window.teststand.settings.update({ welcomeLayout: next });
  };
  const busy = choose.isPending || initialize.isPending || openRecent.isPending;
  const projects = recent.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface-0">
      <Panel as="section" aria-label="最近项目" className="min-h-0 flex-1 bg-surface-0">
        <PanelHeader
          title="最近项目"
          meta={`${projects.length} 个项目`}
          actions={
            <>
              <SegmentedControl<WelcomeLayout>
                label="最近项目布局"
                size="xs"
                value={layout}
                options={layoutOptions}
                onChange={changeLayout}
              />
              <Button variant="primary" size="xs" disabled={busy} onClick={() => choose.mutate()}>
                {choose.isPending ? <Spinner /> : <FolderOpenIcon />}
                打开项目文件夹
              </Button>
            </>
          }
        />
        <PanelBody>
          {error && <div className="mb-3"><ErrorNotice>{error}</ErrorNotice></div>}
          {recent.isLoading ? (
            <div className="grid h-full min-h-40 place-items-center text-fg-3">
              <Spinner label="正在读取最近项目…" />
            </div>
          ) : projects.length === 0 ? (
            <EmptyState
              icon={<ServerIcon />}
              title="还没有项目"
              description="打开一个包含硬件测试用例的文件夹以开始使用"
              action={
                <Button variant="outline" disabled={busy} onClick={() => choose.mutate()}>
                  <FolderOpenIcon />
                  选择文件夹
                </Button>
              }
            />
          ) : (
            <RecentProjectList
              projects={projects}
              layout={layout}
              disabled={busy}
              onOpen={(rootPath) => openRecent.mutate(rootPath)}
              onForget={(rootPath) => forget.mutate(rootPath)}
            />
          )}
        </PanelBody>
      </Panel>

      <InitializeDialog
        selection={selection}
        busy={initialize.isPending}
        onConfirm={() => initialize.mutate()}
        onCancel={() => { if (!initialize.isPending) setSelection(undefined); }}
      />
    </div>
  );
}

function LayoutOption({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <>
      {icon}
      <span className="sr-only">{label}</span>
    </>
  );
}

function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-md border border-fail/40 bg-fail/10 px-3 py-2",
        "text-xs leading-5 break-words whitespace-pre-wrap text-fail"
      )}
    >
      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}
