import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboardIcon, ListChecksIcon, PencilRulerIcon, RadioIcon, ShieldCheckIcon, TimerResetIcon
} from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import { onRunStepFocused } from "../../lib/run-focus.js";
import {
  Button, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, PanelHeader, useConfirm, useToast
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
import { Canvas } from "./Canvas.js";
import { MonitorContext, MonitorTimeContext, type MonitorStaticContextValue, type SelectedFrame } from "./panel-kit.js";
import { PanelProperties } from "./panels/InspectorPanel.js";
import { TimebaseControls } from "./TimebaseControls.js";
import type { BenchRun } from "./use-bench-run.js";
import { useManualControl } from "./use-manual-control.js";
import { setFocusedPanel, useMonitorWorkspace, type MonitorWorkspace } from "./use-monitor-workspace.js";

/**
 * 运行监控 of 测试台架: one canvas page of panels placed freely, like a host-computer front panel —
 * oscilloscopes, values, gauges, big numbers, lamps, XY plots, digital front panels, state timelines, status
 * words, terminals, bus traces, frame details, switches, sliders, buttons and control panels, labels, the
 * run's results and decoded messages — each showing the device streams (or protocol fields) dropped on it, all
 * on one time axis. The canvas is the project's (the Agent builds it too); 编辑布局 moves, resizes and
 * configures panels. Without a run it shows the devices' live data; a run that starts takes over at once, with
 * its event timeline under the canvas; a finished run picked from the history is replayed the same way.
 * Devices can be controlled by hand from the displays and controls, except those a running test holds.
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
  const [editing, setEditing] = useState(false);
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

  const scrollTo = useCallback((tb: number) => setJump((current) => ({ tb, seq: (current?.seq ?? 0) + 1 })), []);
  const zoomStep = useCallback((executionId: string | undefined) => {
    const stepped = stepRange(timeline, executionId);
    if (!stepped) return;
    time.select(stepped);
    const start = timeline?.steps.find((step) => step.executionId === executionId)?.tb0;
    if (start != null) {
      time.pick(start);
      scrollTo(start);
    }
  }, [scrollTo, time, timeline]);
  // A step picked in the test panel's flow.
  const zoomRef = useRef(zoomStep);
  zoomRef.current = zoomStep;
  useEffect(() => onRunStepFocused((executionId) => zoomRef.current(executionId)), []);
  const pick = useCallback((tb: number, scroll: boolean) => {
    time.pick(tb);
    if (scroll) scrollTo(tb);
  }, [scrollTo, time]);
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

  const notify = useMemo(() => ({
    error: (message: string) => toast.error(message),
    success: (message: string) => toast.success(message)
  }), [toast]);
  const selectedPanel = workspace.monitor.panels.find((panel) => panel.id === activePanelId);
  const context = useMemo<MonitorStaticContextValue>(() => ({
    workspace, source, bench, rows, jump, pick, zoomStep, control, frame, selectFrame, activePanelId, notify
  }), [workspace, source, bench, rows, jump, pick, zoomStep, control, frame, selectFrame, activePanelId, notify]);


  const tools = (
    <span className="ml-auto flex items-center gap-1">
      <span className="mr-1 text-2xs whitespace-nowrap text-fg-3">
        {mode === "live" ? "实时数据" : mode === "run" ? "本次运行" : "历史回放"}
      </span>
      <TimebaseControls time={time} />
      <IconButton label="复位时间轴" size="icon-sm" variant="ghost" disabled={time.follow} onClick={time.reset}>
        <TimerResetIcon />
      </IconButton>
      <IconButton label="编辑布局" size="icon-sm" variant="ghost" aria-pressed={editing}
        title={editing ? "完成编辑：控件恢复可操作" : "编辑布局：拖动、改大小、设置和删除控件"}
        className={editing ? "bg-signal/15 text-signal" : undefined}
        onClick={() => setEditing((current) => !current)}>
        <PencilRulerIcon />
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
      <MonitorTimeContext.Provider value={time}>
        <MonitorContext.Provider value={context}>
          <div className="flex min-h-0 flex-1">
            <Canvas key={workspace.projectId ?? "none"} workspace={workspace} editing={editing}
              selected={activePanelId} onSelect={focus}
              empty={<LayoutMenu workspace={workspace} labelled onError={(message) => toast.error(message)}
                onDone={(message) => toast.success(message)} />} />
            {editing && (
              <aside aria-label="属性" className="flex w-64 shrink-0 flex-col border-l border-line bg-surface-1">
                <PanelHeader title="属性" />
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {selectedPanel ? <PanelProperties panel={selectedPanel} />
                    : <p className="p-3 text-2xs text-fg-3">点画布上的一个控件，这里显示它的设置。</p>}
                </div>
              </aside>
            )}
          </div>
        </MonitorContext.Provider>
      </MonitorTimeContext.Provider>
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
    workspace.replace({ panels });
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
