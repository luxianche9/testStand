import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ActivityIcon, CrosshairIcon, GaugeIcon, ListChecksIcon, RadioIcon, TimerResetIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import { useResizableWidth } from "../../lib/resizable.js";
import { onRunStepFocused } from "../../lib/run-focus.js";
import {
  Button, EmptyState, IconButton, SegmentedControl, Splitter, cn, useConfirm, useToast
} from "../../ui/index.js";
import {
  BusTerminal, RunOverview, SignalScope, isSampled, type ConsoleJump, type StreamSource
} from "../streams/index.js";
import { RunControls } from "../testing/EditorToolbar.js";
import { RunHeader } from "../testing/RunHeader.js";
import { RunMessages } from "../testing/RunMessages.js";
import { stepRange } from "../testing/useRunView.js";
import { SPANS, useLiveKeepalive, useMonitorTime, type Span } from "./monitor-time.js";
import type { BenchRun } from "./use-bench-run.js";
import { readDraggedStream, STREAM_MIME, useMonitorChannels } from "./use-monitor-channels.js";

type Lower = "console" | "messages";

/**
 * 运行监控 of 测试台架: the device streams the project shows — sampled ones on the oscilloscope,
 * record ones (serial, bus) in the console — on one time axis. Streams are dragged here from the
 * devices panel. Without a run it shows the devices' live data; a run that starts (from the test
 * panel or by the Agent) takes over at once, with its event timeline (steps, verdicts, device
 * calls) above the scope and its steps, calls and results in the console; a finished run picked
 * from the history is replayed the same way. Picking an instant anywhere marks it everywhere. The
 * panel only watches: devices are controlled from their action dialogs and by test steps.
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
  const monitor = useMonitorChannels(runId ? timeline : undefined);
  const time = useMonitorTime(mode !== "replay", mode === "run" ? origin : undefined,
    mode === "replay" ? view.range : undefined);
  const source = useMemo<StreamSource>(
    () => (mode === "live" || !view.source ? { live: hub } : view.source),
    [mode, hub, view.source]
  );
  useLiveKeepalive(hub, monitor.streams.map((stream) => stream.key));
  const scopeSize = useResizableWidth({
    storageKey: "teststand.monitor-scope-height",
    defaultWidth: 380,
    min: 140,
    max: () => Math.max(220, window.innerHeight - 260),
    direction: "down"
  });
  const [lower, setLower] = useState<Lower>("console");
  const [jump, setJump] = useState<ConsoleJump>();
  const [dropping, setDropping] = useState(false);
  const [rejudging, setRejudging] = useState(false);
  const decoded = runId ? view.decoded : undefined;
  const lowerShown: Lower = decoded ? lower : "console";
  const sampled = monitor.streams.filter((stream) => isSampled(String(stream.type)));
  const records = monitor.streams.filter((stream) => !isSampled(String(stream.type)));

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
  useEffect(() => { if (monitor.error) toast.error(errorMessage(monitor.error)); }, [monitor.error, toast]);

  const accepts = (event: DragEvent) => event.dataTransfer.types.includes(STREAM_MIME);
  const drop = (event: DragEvent) => {
    setDropping(false);
    const ref = readDraggedStream(event.dataTransfer);
    if (!ref) return;
    event.preventDefault();
    monitor.add(ref);
  };

  const tools = (
    <span className="ml-auto flex items-center gap-1">
      <span className="mr-1 text-2xs whitespace-nowrap text-fg-3">
        {mode === "live" ? "实时数据" : mode === "run" ? "本次运行" : "历史回放"}
      </span>
      <GaugeIcon aria-hidden className="size-3.5 text-fg-3" />
      <SegmentedControl<Span> label="时间跨度" size="xs" value={time.span} options={SPANS} onChange={time.setSpan} />
      <IconButton
        label={time.follow ? "停止跟随" : "跟随最新数据"}
        size="icon-sm"
        variant="ghost"
        aria-pressed={time.follow}
        disabled={mode === "replay"}
        onClick={() => (time.follow ? time.select([Date.now() - time.spanMs, Date.now()]) : time.reset())}
      >
        <CrosshairIcon />
      </IconButton>
      <IconButton label="复位时间轴" size="icon-sm" variant="ghost" disabled={time.follow} onClick={time.reset}>
        <TimerResetIcon />
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
      {monitor.streams.length || runId ? (
        <div
          className="grid min-h-0 min-w-0 flex-1"
          style={{ gridTemplateRows: sampled.length ? `${scopeSize.width}px 1px minmax(0,1fr)` : "minmax(0,1fr)" }}
        >
          {sampled.length > 0 && (
            <div className="min-h-0 min-w-0">
              <SignalScope
                streams={sampled}
                timeline={runId ? timeline : undefined}
                source={source}
                follow={time.follow}
                spanMs={time.spanMs}
                from={time.from}
                range={time.range}
                origin={mode === "live" ? undefined : origin}
                marker={time.marker}
                syncKey={runId ? `run:${runId}` : "monitor:live"}
                emptyText="把数据流拖到这里"
                onPick={(tb) => pick(tb, true)}
                onSelectRange={time.select}
                onReset={time.reset}
                onRemove={monitor.remove}
              />
            </div>
          )}
          {sampled.length > 0 && <Splitter label="拖拽调整示波器高度" {...scopeSize.separatorProps} />}
          <div className="flex min-h-0 min-w-0 flex-col">
            {decoded && (
              <div className="flex h-8 shrink-0 items-center border-b border-line bg-surface-1 px-2">
                <SegmentedControl<Lower>
                  label="下方面板"
                  size="xs"
                  value={lowerShown}
                  onChange={setLower}
                  options={[{ value: "console", label: "控制台" }, { value: "messages", label: `报文 ${decoded.total}` }]}
                />
              </div>
            )}
            <div className={lowerShown === "console" ? "min-h-0 flex-1" : "hidden"}>
              <BusTerminal
                key={runId ?? "live"}
                streams={records}
                timeline={runId ? timeline : undefined}
                source={source}
                live={mode !== "replay"}
                origin={mode === "live" ? undefined : origin}
                jump={jump}
                stepNames={runId ? view.stepNames : undefined}
                extra={runId ? view.results : undefined}
                onPick={(tb) => pick(tb, false)}
                onStep={zoomStep}
              />
            </div>
            {decoded && lowerShown === "messages" && (
              <div className="min-h-0 flex-1">
                <RunMessages data={decoded} origin={origin} jump={jump} onPick={(tb) => pick(tb, false)} />
              </div>
            )}
          </div>
        </div>
      ) : (
        <EmptyState
          className="min-h-0 flex-1"
          icon={<ActivityIcon />}
          title="运行监控还没有数据流"
          description="在左侧「设备管理」里展开一台设备，把它的数据流拖到这里：采样流显示在示波器上，串口和总线的收发显示在控制台里。"
        />
      )}
      {confirmDialog}
    </section>
  );
}
