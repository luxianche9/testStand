import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import "@xyflow/react/dist/style.css";
import type { ProjectFolderSelection } from "@hardwareharness/contracts/projects";
import type { WelcomeLayout } from "@hardwareharness/contracts/storage";
import { CircleAlertIcon, FolderOpenIcon, Grid2X2Icon, ListIcon, ServerIcon } from "lucide-react";
import { InitializeDialog } from "../../app/InitializeDialog.js";
import { errorMessage } from "../../lib/errors.js";
import { useDeviceCatalog, useRecentProjects } from "../../lib/queries.js";
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
  const catalog = useDeviceCatalog();
  const [layout, setLayout] = useState<WelcomeLayout>("grid");
  const [selection, setSelection] = useState<ProjectFolderSelection>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void window.hardwareharness.settings.getWelcomeLayout().then(setLayout);
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
    await window.hardwareharness.projects.openFolder(next.rootPath);
    await onOpened(next.rootPath);
  };

  const choose = useMutation({
    mutationFn: () => window.hardwareharness.projects.chooseFolder(),
    onSuccess: async (next) => { if (next) await openSelection(next); },
    onError: (reason) => setError(errorMessage(reason))
  });
  const initialize = useMutation({
    mutationFn: async () => {
      if (!selection) return null;
      return await window.hardwareharness.projects.initializeFolder(selection.rootPath);
    },
    onSuccess: async (document) => {
      if (!document) return;
      setSelection(undefined);
      await onOpened(document.rootPath);
    },
    onError: (reason) => setError(errorMessage(reason))
  });
  const openRecent = useMutation({
    mutationFn: (rootPath: string) => window.hardwareharness.projects.openFolder(rootPath),
    onSuccess: async (document) => { await onOpened(document.rootPath); },
    onError: (reason) => setError(errorMessage(reason))
  });
  const forget = useMutation({
    mutationFn: (rootPath: string) => window.hardwareharness.projects.forgetRecent(rootPath),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: queryKeys.recentProjects }); },
    onError: (reason) => setError(errorMessage(reason))
  });

  const changeLayout = (next: WelcomeLayout) => {
    setLayout(next);
    void window.hardwareharness.settings.setWelcomeLayout(next);
  };
  const busy = choose.isPending || initialize.isPending || openRecent.isPending;
  const projects = recent.data ?? [];
  const available = projects.filter((project) => project.status === "available").length;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,340px)_minmax(0,1fr)] bg-surface-0">
      <section
        aria-label="开始"
        className="flex min-h-0 flex-col gap-6 overflow-y-auto border-r border-line bg-surface-1 p-8"
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className={cn(
              "grid size-10 shrink-0 place-items-center rounded-md border border-signal/60 bg-signal/12",
              "font-mono text-sm font-bold text-signal"
            )}
          >
            HH
          </span>
          <div className="grid gap-0.5">
            <span className="tf-label">欢迎使用</span>
            <h1 className="text-lg leading-6 font-semibold tracking-tight text-fg">HardwareHarness</h1>
          </div>
        </div>
        <p className="text-sm leading-6 text-fg-2">
          硬件设备与接线工作台。选择一个项目文件夹开始工作；尚未初始化的文件夹会先创建项目清单。
        </p>
        <div className="grid gap-2">
          <Button variant="primary" size="lg" className="justify-start" disabled={busy} onClick={() => choose.mutate()}>
            {choose.isPending ? <Spinner /> : <FolderOpenIcon />}
            打开项目文件夹
          </Button>
          {error && <ErrorNotice>{error}</ErrorNotice>}
        </div>
        <dl className="mt-auto grid grid-cols-3 gap-3 border-t border-line pt-4">
          <Stat label="项目" value={projects.length} />
          <Stat label="可用" value={available} />
          <Stat label="异常" value={projects.length - available} warn={projects.length > available} />
        </dl>
      </section>

      <Panel as="section" aria-label="最近项目" className="bg-surface-0">
        <PanelHeader
          title="最近项目"
          meta={`${projects.length} 个项目`}
          actions={
            <SegmentedControl<WelcomeLayout>
              label="最近项目布局"
              size="xs"
              value={layout}
              options={layoutOptions}
              onChange={changeLayout}
            />
          }
        />
        <PanelBody>
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
              hardware={catalog.data?.hardware ?? []}
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

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <dt className="tf-label">{label}</dt>
      <dd className={cn("tf-num text-base leading-5", warn ? "text-invalid" : "text-fg")}>{value}</dd>
    </div>
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
