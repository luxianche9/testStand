import { useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  DockviewDefaultTab, DockviewReact, type DockviewApi, type DockviewReadyEvent, type DockviewTheme,
  type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type SerializedDockview
} from "dockview-react";
import {
  ActivityIcon, ListChecksIcon, Maximize2Icon, Minimize2Icon, PictureInPicture2Icon, PlusIcon, RadioIcon,
  TimerResetIcon
} from "lucide-react";
import { PANEL_TYPES, type MonitorPanel, type PanelType } from "@teststand/contracts/monitor";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import { onRunStepFocused } from "../../lib/run-focus.js";
import {
  Button, cn, EmptyState, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, useConfirm, useToast
} from "../../ui/index.js";
import { RunOverview, streamUnit, type ConsoleJump, type StreamSource } from "../streams/index.js";
import { RunControls } from "../testing/EditorToolbar.js";
import { RunHeader } from "../testing/RunHeader.js";
import { resultRows } from "../testing/result-rows.js";
import { stepRange } from "../testing/useRunView.js";
import { useLiveKeepalive, useMonitorTime } from "./monitor-time.js";
import { MonitorContext, PANEL_COMPONENTS, type MonitorContextValue } from "./MonitorPanels.js";
import { TimebaseControls } from "./TimebaseControls.js";
import type { BenchRun } from "./use-bench-run.js";
import {
  PANEL_LABELS, panelTitle, readDraggedStream, STREAM_MIME, useMonitorWorkspace, type MonitorWorkspace
} from "./use-monitor-workspace.js";

const THEME: DockviewTheme = { name: "teststand", className: "dockview-theme-teststand", gap: 2 };
/** Layout changes this soon after loading or a window resize are the layout settling, not edits. */
const SETTLE_MS = 1_200;
const SAVE_DELAY_MS = 400;

/**
 * 运行监控 of 测试台架: a docking workspace of panels — oscilloscopes, digital front panels,
 * terminals, the run's results and decoded messages — each showing the device streams dropped on
 * it, all on one time axis. The panels and their layout are the project's (the Agent builds them
 * too). Without a run it shows the devices' live data; a run that starts (from the test panel or by
 * the Agent) takes over at once, with its event timeline (steps, verdicts, device calls) above the
 * panels; a finished run picked from the history is replayed the same way. Picking an instant
 * anywhere marks it everywhere. The panels only watch: devices are controlled from their action
 * dialogs and by test steps.
 */
export function MonitorPane({ bench, toolbar }: {
  bench: BenchRun;
  /** Where the bench's title row keeps this view's tools. */
  toolbar: HTMLElement | null;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const { run, hub, runId, setRunId, live, mode, view } = bench;
  const { timeline, origin } = view;
  const workspace = useMonitorWorkspace(runId ? timeline : undefined);
  const time = useMonitorTime(mode !== "replay", mode === "run" ? origin : undefined,
    mode === "replay" ? view.range : undefined);
  const source = useMemo<StreamSource>(
    () => (mode === "live" || !view.source ? { live: hub } : view.source),
    [mode, hub, view.source]
  );
  useLiveKeepalive(hub, workspace.streams.map((stream) => stream.key));
  const [jump, setJump] = useState<ConsoleJump>();
  const [dropping, setDropping] = useState(false);
  const [rejudging, setRejudging] = useState(false);
  const results = view.runLog.log?.results;
  const rows = useMemo(() => {
    if (!runId || !results) return [];
    const units = new Map((timeline?.streams ?? []).map((stream) =>
      [`${stream.hardwareId}/${stream.streamId}`, stream.declaration?.unit ?? streamUnit(stream)]));
    return resultRows(results, (hardwareId, streamId) => units.get(`${hardwareId}/${streamId}`) ?? "");
  }, [runId, results, timeline?.streams]);

  const scrollTo = (tb: number) => setJump((current) => ({ tb, seq: (current?.seq ?? 0) + 1 }));
  const zoomStep = (executionId: string | undefined) => {
    const stepped = stepRange(timeline, executionId);
    if (!stepped) return;
    time.select(stepped);
    const start = timeline?.steps.find((step) => step.executionId === executionId)?.tb0;
    if (start != null) {
      time.pick(start);
      scrollTo(start);
    }
  };
  // A step picked in the test panel's flow.
  const zoomRef = useRef(zoomStep);
  zoomRef.current = zoomStep;
  useEffect(() => onRunStepFocused((executionId) => zoomRef.current(executionId)), []);
  const pick = (tb: number, scroll: boolean) => {
    time.pick(tb);
    if (scroll) scrollTo(tb);
  };
  const refreshRun = () => {
    void client.invalidateQueries({ queryKey: queryKeys.testRun });
  };
  const rejudge = async () => {
    if (!runId) return;
    setRejudging(true);
    try {
      const result = await window.teststand.testing.rejudgeRun({ runId });
      const changed = result.results.filter((item) => !item.same).length;
      if (result.consistent) toast.success(`复核一致：${result.results.length} 项判定与原结果相同`);
      else toast.error(`复核发现 ${changed} 项判定与原结果不同`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRejudging(false);
    }
  };
  useEffect(() => { if (workspace.error) toast.error(errorMessage(workspace.error)); }, [workspace.error, toast]);

  const context: MonitorContextValue = {
    workspace, time, source, bench, rows, jump, pick, zoomStep, onRefused: (message) => toast.error(message)
  };

  // A stream dropped outside every panel goes to the first panel that draws it.
  const accepts = (event: DragEvent) => event.dataTransfer.types.includes(STREAM_MIME);
  const drop = (event: DragEvent) => {
    setDropping(false);
    const ref = readDraggedStream(event.dataTransfer);
    if (!ref) return;
    event.preventDefault();
    workspace.add(ref);
  };

  const tools = (
    <span className="ml-auto flex items-center gap-1">
      <span className="mr-1 text-2xs whitespace-nowrap text-fg-3">
        {mode === "live" ? "实时数据" : mode === "run" ? "本次运行" : "历史回放"}
      </span>
      <TimebaseControls time={time} />
      <IconButton label="复位时间轴" size="icon-sm" variant="ghost" disabled={time.follow} onClick={time.reset}>
        <TimerResetIcon />
      </IconButton>
      <AddPanelMenu onAdd={(type) => workspace.addPanel(type)} />
    </span>
  );
  const runActions = (
    <>
      {mode === "replay" && (
        <Button size="xs" variant="outline" onClick={() => setRunId(undefined)}><RadioIcon />返回实时</Button>
      )}
      {live && <RunControls run={run} confirm={confirm} onStart={() => undefined} onChanged={refreshRun} />}
      {!live && Boolean(timeline?.windows.length) && (
        <Button size="xs" variant="outline" disabled={rejudging} onClick={() => void rejudge()}>
          <ListChecksIcon />复核判定
        </Button>
      )}
    </>
  );

  return (
    <section
      aria-label="运行监控"
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col",
        dropping && "outline-2 -outline-offset-2 outline-signal"
      )}
      onDragOver={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={drop}
    >
      {toolbar && createPortal(tools, toolbar)}
      {runId && (
        <RunHeader
          state={view.runLog}
          trace={view.trace}
          activeExecutionIds={view.activeExecutionIds}
          problemExecutionId={view.problemExecutionId}
          following={time.follow}
          onCurrent={time.reset}
          onProblem={() => zoomStep(view.problemExecutionId)}
          actions={runActions}
        />
      )}
      {runId && timeline && view.range && origin !== undefined && (
        <RunOverview
          timeline={timeline}
          stepNames={view.stepNames}
          range={view.range}
          origin={origin}
          marker={time.marker}
          onSelect={time.select}
          onStep={zoomStep}
          onPick={(tb) => pick(tb, true)}
        />
      )}
      {workspace.monitor.panels.length ? (
        <MonitorContext.Provider value={context}>
          <Workspace key={workspace.projectId ?? "none"} workspace={workspace} />
        </MonitorContext.Provider>
      ) : (
        <EmptyState
          className="min-h-0 flex-1"
          icon={<ActivityIcon />}
          title="运行监控还没有面板"
          description="在左侧「设备管理」里展开一台设备，把它的数据流拖到这里：采样流进示波器，串口和总线的收发进终端。也可以先加一个面板，再把数据流拖到面板上。"
          action={<AddPanelMenu onAdd={(type) => workspace.addPanel(type)} labelled />}
        />
      )}
      {confirmDialog}
    </section>
  );
}

function AddPanelMenu({ onAdd, labelled = false }: { onAdd: (type: PanelType) => void; labelled?: boolean }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        {labelled
          ? <Button size="xs" variant="outline"><PlusIcon />添加面板</Button>
          : <IconButton label="添加面板" size="icon-sm" variant="ghost"><PlusIcon /></IconButton>}
      </MenuTrigger>
      <MenuContent align="end">
        {PANEL_TYPES.map((type) => (
          <MenuItem key={type} onSelect={() => onAdd(type)}>{PANEL_LABELS[type]}</MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Where a panel the layout does not have yet docks: its placement hint, else right of the last. */
function position(api: DockviewApi, panel: MonitorPanel) {
  const reference = panel.placement?.referenceId ?? api.panels.at(-1)?.id;
  if (!reference || !api.getPanel(reference)) return undefined;
  return { referencePanel: reference, direction: panel.placement?.direction ?? "right" } as const;
}

/**
 * The dockview grid, kept in step with the project's panels: panels the project gained (from this
 * view or the Agent) are docked by their placement, ones it lost are closed, and the user's
 * arrangement is saved back as the project's layout.
 */
function Workspace({ workspace }: { workspace: MonitorWorkspace }) {
  const [api, setApi] = useState<DockviewApi>();
  const { panels, layout } = workspace.monitor;
  const latest = useRef({ workspace, layout });
  latest.current = { workspace, layout };
  const settledAt = useRef(0);
  const settle = () => { settledAt.current = performance.now() + SETTLE_MS; };

  const onReady = useCallback((event: DockviewReadyEvent) => {
    settle();
    const saved = latest.current.layout;
    if (saved) {
      try {
        event.api.fromJSON(saved as unknown as SerializedDockview);
      } catch {
        event.api.clear();
      }
    }
    setApi(event.api);
  }, []);

  useEffect(() => {
    if (!api) return;
    const wanted = new Set(panels.map((panel) => panel.id));
    for (const panel of [...api.panels]) if (!wanted.has(panel.id)) api.removePanel(panel);
    for (const panel of panels) {
      const docked = api.getPanel(panel.id);
      const title = panelTitle(panel);
      if (!docked) {
        const at = position(api, panel);
        api.addPanel({ id: panel.id, component: panel.type, title, ...(at ? { position: at } : {}) });
      } else if (docked.title !== title) {
        docked.api.setTitle(title);
      }
    }
  }, [api, panels]);

  useEffect(() => {
    if (!api) return undefined;
    let timer: number | undefined;
    const changed = api.onDidLayoutChange(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (performance.now() < settledAt.current) return;
        const next = api.toJSON() as unknown as Record<string, unknown>;
        if (JSON.stringify(next) !== JSON.stringify(latest.current.layout)) latest.current.workspace.saveLayout(next);
      }, SAVE_DELAY_MS);
    });
    window.addEventListener("resize", settle);
    return () => {
      changed.dispose();
      window.clearTimeout(timer);
      window.removeEventListener("resize", settle);
    };
  }, [api]);

  return (
    <div className="min-h-0 flex-1">
      <DockviewReact
        theme={THEME}
        components={PANEL_COMPONENTS}
        defaultTabComponent={PanelTab}
        rightHeaderActionsComponent={GroupActions}
        onReady={onReady}
        disableFloatingGroups={false}
      />
    </div>
  );
}

/** A panel's tab; closing it removes the panel from the project. */
function PanelTab(props: IDockviewPanelHeaderProps) {
  const monitor = useContext(MonitorContext);
  return <DockviewDefaultTab {...props} closeActionOverride={() => monitor?.workspace.removePanel(props.api.id)} />;
}

/** Maximize a group or float it over the others. */
function GroupActions({ containerApi, group, activePanel }: IDockviewHeaderActionsProps) {
  const [maximized, setMaximized] = useState(() => containerApi.hasMaximizedGroup());
  useEffect(() => {
    const changed = containerApi.onDidMaximizedGroupChange(() => setMaximized(containerApi.hasMaximizedGroup()));
    return () => changed.dispose();
  }, [containerApi]);
  const floating = group.api.location.type === "floating";
  return (
    <div className="flex h-full items-center gap-0.5 px-1">
      {!floating && (
        <IconButton label="浮动" size="icon-xs" variant="ghost" onClick={() => containerApi.addFloatingGroup(group)}>
          <PictureInPicture2Icon />
        </IconButton>
      )}
      {!floating && activePanel && (
        <IconButton
          label={maximized ? "还原" : "最大化"}
          size="icon-xs"
          variant="ghost"
          onClick={() => (maximized ? containerApi.exitMaximizedGroup() : containerApi.maximizeGroup(activePanel))}
        >
          {maximized ? <Minimize2Icon /> : <Maximize2Icon />}
        </IconButton>
      )}
    </div>
  );
}
