import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  DockviewDefaultTab, DockviewReact, type DockviewApi, type DockviewReadyEvent, type DockviewTheme,
  type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type SerializedDockview
} from "dockview-react";
import {
  ActivityIcon, ExternalLinkIcon, LayoutDashboardIcon, ListChecksIcon, Maximize2Icon, Minimize2Icon,
  PictureInPicture2Icon, PlusIcon, RadioIcon, ShieldCheckIcon, TimerResetIcon
} from "lucide-react";
import type { Direction, MonitorPanel, PanelType } from "@teststand/contracts/monitor";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import { onRunStepFocused } from "../../lib/run-focus.js";
import {
  Button, cn, EmptyState, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, useConfirm, useToast
} from "../../ui/index.js";
import { RunOverview, streamUnit, type ConsoleJump, type StreamSource } from "../streams/index.js";
import { RunControls } from "../testing/EditorToolbar.js";
import { RunHeader } from "../testing/RunHeader.js";
import { resultRows } from "../testing/result-rows.js";
import { stepRange } from "../testing/useRunView.js";
import {
  deletePreset, exportText, generatedLayout, importText, readPresets, savePreset, type LayoutPreset
} from "./layout-tools.js";
import { useLiveKeepalive, useMonitorTime } from "./monitor-time.js";
import { PANEL_COMPONENTS } from "./MonitorPanels.js";
import { MonitorContext, type MonitorContextValue, type SelectedFrame } from "./panel-kit.js";
import { TimebaseControls } from "./TimebaseControls.js";
import type { BenchRun } from "./use-bench-run.js";
import { useManualControl } from "./use-manual-control.js";
import { ComponentBar } from "./ComponentBar.js";
import {
  PANEL_LABELS, PANEL_MIME, panelTitle, setFocusedPanel, useMonitorWorkspace, type MonitorWorkspace
} from "./use-monitor-workspace.js";

const THEME: DockviewTheme = { name: "teststand", className: "dockview-theme-teststand", gap: 2 };
/** Layout changes this soon after loading or a window resize are the layout settling, not edits. */
const SETTLE_MS = 1_200;
const SAVE_DELAY_MS = 400;
/** The page a pop-out panel opens with; the main process allows nothing else (src/main/windows.ts). */
const POPOUT_URL = "about:blank";

/**
 * 运行监控 of 测试台架: a docking workspace of panels — oscilloscopes, values, gauges, XY plots,
 * digital front panels, state timelines, status words, terminals, bus traces, frame details,
 * control panels, the data-source tree and a property panel, the run's results and decoded
 * messages — each showing the device streams dropped on it, all on one time axis. The panels and
 * their layout are the project's (the Agent builds them too); panels can float or pop out to a
 * window of their own. Without a run it shows the devices' live data; a run that starts takes over
 * at once, with its event timeline under the panels; a finished run picked from the history is
 * replayed the same way. Picking an instant anywhere marks it everywhere. Devices can be
 * controlled by hand from the displays and control panels, except those a running test holds.
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
  const control = useManualControl();
  const time = useMonitorTime(mode !== "replay", mode === "run" ? origin : undefined,
    mode === "replay" ? view.range : undefined);
  const source = useMemo<StreamSource>(
    () => (mode === "live" || !view.source ? { live: hub } : view.source),
    [mode, hub, view.source]
  );
  useLiveKeepalive(hub, workspace.streams.map((stream) => stream.key));
  const [jump, setJump] = useState<ConsoleJump>();
  const [rejudging, setRejudging] = useState(false);
  const [frame, selectFrame] = useState<SelectedFrame>();
  const [activePanelId, setActivePanelId] = useState<string>();
  const focus = useCallback((id: string | undefined) => {
    setActivePanelId(id);
    setFocusedPanel(id);
  }, []);
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

  const safeAll = async () => {
    const ok = await confirm({
      title: "全部回到安全状态",
      message: "依次调用每台设备的安全状态工具：模拟输出回 0、数字输出拉低、继电器释放、波形停止。",
      confirmLabel: "全部安全",
      danger: true
    });
    if (!ok) return;
    const failures = await control.safeAll();
    if (failures.length) toast.error(`有设备未能回到安全状态：${failures.join("；")}`);
    else toast.success("所有设备已回到安全状态");
  };

  const context: MonitorContextValue = {
    workspace, time, source, bench, rows, jump, pick, zoomStep, control, frame, selectFrame, activePanelId,
    notify: { error: (message) => toast.error(message), success: (message) => toast.success(message) }
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
      <LayoutMenu workspace={workspace} onError={(message) => toast.error(message)}
        onDone={(message) => toast.success(message)} />
      <IconButton label="全部安全状态" size="icon-sm" variant="ghost" disabled={control.running}
        title={control.running ? "测试运行中，由测试流程负责安全状态" : "所有设备回到安全状态"}
        onClick={() => void safeAll()}>
        <ShieldCheckIcon />
      </IconButton>
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
    <section aria-label="运行监控" className="relative flex h-full min-h-0 min-w-0 flex-col">
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
      <ComponentBar onAdd={(type) => workspace.addPanel(type)} />
      <MonitorContext.Provider value={context}>
        <Workspace key={workspace.projectId ?? "none"} workspace={workspace}
          onActive={focus}
          empty={<LayoutMenu workspace={workspace} labelled onError={(message) => toast.error(message)}
            onDone={(message) => toast.success(message)} />} />
      </MonitorContext.Provider>
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
      {confirmDialog}
    </section>
  );
}

/** Generated layout, saved presets, and the workspace as a file. */
function LayoutMenu({ workspace, labelled = false, onError, onDone }: {
  workspace: MonitorWorkspace;
  labelled?: boolean;
  onError: (message: string) => void;
  onDone: (message: string) => void;
}) {
  const [presets, setPresets] = useState<LayoutPreset[]>([]);
  const file = useRef<HTMLInputElement>(null);
  const generate = () => {
    const streams = workspace.channels.length
      ? workspace.channels
      : workspace.devices.flatMap((device) =>
        device.streams.map((stream) => ({ hardwareId: device.hardwareId, streamId: stream.id })));
    const panels = generatedLayout(streams.map((ref) => ({
      ...ref, type: String(workspace.typeOf(ref) ?? "scalar"), declaration: workspace.declarationOf(ref) as never
    })));
    workspace.replace({ panels, layout: null });
    onDone(workspace.channels.length ? "已按现有数据流重新生成布局" : "已按所有设备的数据流生成布局");
  };
  const save = () => {
    const name = globalThis.prompt?.("预设名称", "台架布局")?.trim();
    if (!name) return;
    setPresets(savePreset(name, workspace.monitor));
    onDone(`已保存预设「${name}」`);
  };
  const exportFile = () => {
    const blob = new Blob([exportText(workspace.monitor)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "monitor-layout.json";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <>
      <Menu onOpenChange={(open) => { if (open) setPresets(readPresets()); }}>
        <MenuTrigger asChild>
          {labelled
            ? <Button size="xs" variant="outline"><LayoutDashboardIcon />布局</Button>
            : <IconButton label="布局" size="icon-sm" variant="ghost"><LayoutDashboardIcon /></IconButton>}
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={generate}>按数据生成布局</MenuItem>
          <MenuSeparator />
          {presets.map((preset) => (
            <MenuItem key={preset.name}
              onSelect={() => { workspace.replace(preset.monitor); onDone(`已应用预设「${preset.name}」`); }}>
              应用预设：{preset.name}
            </MenuItem>
          ))}
          <MenuItem onSelect={save}>保存为预设…</MenuItem>
          {presets.length > 0 && (
            <MenuItem danger onSelect={() => {
              const name = globalThis.prompt?.(`删除哪个预设？（${presets.map((item) => item.name).join("、")}）`)?.trim();
              if (name) setPresets(deletePreset(name));
            }}>删除预设…</MenuItem>
          )}
          <MenuSeparator />
          <MenuItem onSelect={exportFile}>导出布局文件…</MenuItem>
          <MenuItem onSelect={() => file.current?.click()}>导入布局文件…</MenuItem>
        </MenuContent>
      </Menu>
      <input ref={file} type="file" accept="application/json,.json" hidden aria-hidden
        onChange={async (event) => {
          const chosen = event.target.files?.[0];
          event.target.value = "";
          if (!chosen) return;
          const parsed = importText(await chosen.text());
          if (typeof parsed === "string") onError(parsed);
          else { workspace.replace(parsed); onDone(`已导入 ${chosen.name}`); }
        }} />
    </>
  );
}

/**
 * Where a panel the layout does not have yet docks: its placement hint, else beside the panel last
 * focused — to its right when that group is wide, below it when it is narrow.
 */
function position(api: DockviewApi, panel: MonitorPanel) {
  const reference = panel.placement?.referenceId ?? api.activePanel?.id ?? api.panels.at(-1)?.id;
  const target = reference ? api.getPanel(reference) : undefined;
  if (!target) return undefined;
  const { width, height } = target.group.api;
  const direction = panel.placement?.direction ?? (width >= Math.max(480, height * 1.2) ? "right" : "below");
  return { referencePanel: target.id, direction } as const;
}

let popoutsReady = false;

/**
 * Makes dockview's pop-out windows work in Electron: dockview fills a new window on its `load`
 * event, but an `about:blank` window has usually loaded by the time `window.open` returns, so it is
 * told once more; the window also takes the app's theme. Covers pop-outs opened from a button and
 * those a saved layout reopens.
 */
function preparePopouts(): void {
  if (popoutsReady) return;
  popoutsReady = true;
  const open = window.open.bind(window);
  window.open = (url, target, features) => {
    const child = open(url, target, features);
    if (!child || String(url) !== POPOUT_URL) return child;
    let loaded = false;
    child.addEventListener("load", () => { loaded = true; }, { once: true });
    window.setTimeout(() => {
      if (!loaded && child.document.readyState === "complete") child.dispatchEvent(new Event("load"));
    }, 0);
    const stop = followTheme(child);
    child.addEventListener("beforeunload", stop, { once: true });
    return child;
  };
}

/** A pop-out window takes the app's theme (and keeps it when the theme changes). */
function followTheme(target: Window): () => void {
  const copy = () => {
    const theme = document.documentElement.dataset.theme;
    if (theme) target.document.documentElement.dataset.theme = theme;
    else delete target.document.documentElement.dataset.theme;
  };
  copy();
  const observer = new MutationObserver(copy);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/**
 * The dockview grid, kept in step with the project's panels: panels the project gained (from this
 * view or the Agent) are docked by their placement, ones it lost are closed, a layout replaced
 * from outside (a preset, an import) is loaded, and the user's arrangement is saved back.
 */
function Workspace({ workspace, onActive, empty }: {
  workspace: MonitorWorkspace;
  onActive: (id: string | undefined) => void;
  /** Offered while the workspace is empty, next to the hint. */
  empty: ReactNode;
}) {
  const [api, setApi] = useState<DockviewApi>();
  const { panels, layout } = workspace.monitor;
  const latest = useRef({ workspace, layout });
  latest.current = { workspace, layout };
  /** The layout this view last loaded or saved, so only someone else's layout is loaded. */
  const known = useRef<string>(JSON.stringify(layout ?? null));
  const settledAt = useRef(0);
  const settle = () => { settledAt.current = performance.now() + SETTLE_MS; };

  const load = useCallback((target: DockviewApi, saved: Record<string, unknown> | null) => {
    settle();
    known.current = JSON.stringify(saved ?? null);
    target.clear();
    if (!saved) return;
    try {
      target.fromJSON(saved as unknown as SerializedDockview);
    } catch {
      target.clear();
    }
  }, []);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    preparePopouts();
    // Components dragged from the component bar dock where dockview shows; nothing else is taken.
    event.api.onUnhandledDragOverEvent((drag) => {
      if (drag.nativeEvent.dataTransfer?.types.includes(PANEL_MIME)) drag.accept();
    });
    load(event.api, latest.current.layout);
    setApi(event.api);
  }, [load]);

  // A layout set from outside this view (preset, import, generated layout) replaces the grid.
  useEffect(() => {
    if (!api) return;
    const text = JSON.stringify(layout ?? null);
    if (text !== known.current) load(api, layout);
  }, [api, layout, load]);

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
        const text = JSON.stringify(next);
        if (text === known.current) return;
        known.current = text;
        latest.current.workspace.saveLayout(next);
      }, SAVE_DELAY_MS);
    });
    const active = api.onDidActivePanelChange((panel) => { if (panel) onActive(panel.id); });
    window.addEventListener("resize", settle);
    return () => {
      changed.dispose();
      active.dispose();
      window.clearTimeout(timer);
      window.removeEventListener("resize", settle);
    };
  }, [api, onActive]);

  return (
    <div className="min-h-0 flex-1">
      <DockviewReact
        theme={THEME}
        components={PANEL_COMPONENTS}
        defaultTabComponent={PanelTab}
        rightHeaderActionsComponent={GroupActions}
        onReady={onReady}
        popoutUrl={POPOUT_URL}
        watermarkComponent={() => <Watermark action={empty} />}
        onDidDrop={(event) => {
          const type = event.nativeEvent.dataTransfer?.getData(PANEL_MIME) as PanelType | undefined;
          if (!type || !PANEL_LABELS[type]) return;
          const reference = event.group?.activePanel?.id;
          const direction = DROP_DIRECTIONS[event.position] ?? "right";
          latest.current.workspace.addPanel(type, [],
            reference ? { referenceId: reference, direction } : { direction });
        }}
      />
    </div>
  );
}

/** dockview's drop positions as panel placements. */
const DROP_DIRECTIONS: Record<string, Direction> = {
  top: "above", bottom: "below", left: "left", right: "right", center: "within"
};

/** What an empty workspace says: components first, then signals onto them. */
function Watermark({ action }: { action: ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="grid max-w-md justify-items-center gap-2 text-xs text-fg-3">
        <LayoutDashboardIcon className="size-6" />
        <p className="text-sm text-fg-2">把上方组件栏里的组件拖到这里</p>
        <p>
          再从左侧「设备管理」把信号拖到组件上：模拟量拖到示波器或数值表，数字量拖到数字量组件，
          串口拖到终端。信号只能放进能显示它的组件。
        </p>
        {action}
      </div>
    </div>
  );
}

/** A panel's tab; closing it removes the panel from the project. */
function PanelTab(props: IDockviewPanelHeaderProps) {
  const monitor = useContext(MonitorContext);
  return <DockviewDefaultTab {...props} closeActionOverride={() => monitor?.workspace.removePanel(props.api.id)} />;
}

/** Pop out to a window of its own (another screen), float over the others, or maximize. */
function GroupActions({ containerApi, group, activePanel }: IDockviewHeaderActionsProps) {
  const [maximized, setMaximized] = useState(() => containerApi.hasMaximizedGroup());
  useEffect(() => {
    const changed = containerApi.onDidMaximizedGroupChange(() => setMaximized(containerApi.hasMaximizedGroup()));
    return () => changed.dispose();
  }, [containerApi]);
  const where = group.api.location.type;
  return (
    <div className="flex h-full items-center gap-0.5 px-1">
      {where !== "popout" && (
        <IconButton label="弹出到独立窗口" size="icon-xs" variant="ghost"
          onClick={() => void containerApi.addPopoutGroup(group, { popoutUrl: POPOUT_URL })}>
          <ExternalLinkIcon />
        </IconButton>
      )}
      {where === "grid" && (
        <IconButton label="浮动" size="icon-xs" variant="ghost" onClick={() => containerApi.addFloatingGroup(group)}>
          <PictureInPicture2Icon />
        </IconButton>
      )}
      {where === "grid" && activePanel && (
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
