import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CrosshairIcon, ListChecksIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, ScrollTextIcon, ZoomOutIcon
} from "lucide-react";
import type { RunTimeline } from "@teststand/contracts/observability";
import type { TestRunSnapshot } from "@teststand/contracts/testing";
import { Button, EmptyState, IconButton, SegmentedControl, Splitter, useConfirm } from "../../ui";
import { useToast } from "../../ui/toast.js";
import { errorMessage } from "../../lib/errors.js";
import { useResizableWidth } from "../../lib/resizable.js";
import { useCurrentTestRun, useTestItemStatus, useTestStepCatalog } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import { onRunRequested, peekRequestedRun, takeRequestedRun } from "../../lib/run-focus.js";
import {
  BusTerminal, PRE_ROLL_MS, RunOverview, runRange, SignalScope,
  type ConsoleJump, type StreamSource, type TimeRange
} from "../streams/index.js";
import { RunControls } from "./EditorToolbar.js";
import { isActiveRun } from "./plan-helpers.js";
import { activeExecutions, firstProblemExecution, planOutlineEntries, resultConsoleEntries } from "./run-format.js";
import { buildExecutionTrace } from "./run-log-model.js";
import { RunHeader } from "./RunHeader.js";
import { RunHistory } from "./RunHistory.js";
import { RunMessages } from "./RunMessages.js";
import { useRunLog } from "./useRunLog.js";

const SPANS = [
  { value: "2000", label: "2 s" },
  { value: "10000", label: "10 s" },
  { value: "60000", label: "1 min" },
  { value: "all", label: "全程" }
] as const;
type Span = (typeof SPANS)[number]["value"];
type Lower = "console" | "messages";

/** Where an instant was picked; the picking instrument does not scroll itself. */
type PickSource = "scope" | "console" | "messages" | "overview";

const HISTORY_KEY = "teststand.run-history-open";

function storedHistoryOpen(): boolean {
  try { return localStorage.getItem(HISTORY_KEY) !== "false"; } catch { return true; }
}

/**
 * 运行监控: every test run on the left; the selected run under a header of its verdict, progress
 * and controls, as a set of instruments on one time axis — an overview of steps, verdicts and
 * calls, a multi-channel oscilloscope, and a console of every step, device call with what the
 * device returned, bus record and result. Picking an instant anywhere moves all of them.
 */
export function RunMonitorPage() {
  const status = useTestItemStatus();
  const currentRun = useCurrentTestRun();
  const run = currentRun.data;
  const [runId, setRunId] = useState<string | undefined>(() => peekRequestedRun() ?? activeRunId(run));
  const left = useResizableWidth({
    storageKey: "teststand.run-log-sidebar-width", defaultWidth: 280, min: 220, max: 640, direction: "right"
  });
  const plans = (status.data?.items ?? []).map((item) => ({ id: item.planId, name: item.name }));
  // Collapsed, the run history folds into the monitor's title bar; nothing selected keeps it open.
  const [historyOpen, setHistoryOpen] = useState(storedHistoryOpen);
  const showHistory = historyOpen || !runId;
  const toggleHistory = () => setHistoryOpen((open) => {
    try { localStorage.setItem(HISTORY_KEY, String(!open)); } catch { /* Storage may be unavailable. */ }
    return !open;
  });
  const historyToggle = (
    <Button
      size="xs"
      variant="ghost"
      aria-expanded={showHistory}
      title={showHistory ? "收起运行记录" : "展开运行记录"}
      onClick={toggleHistory}
    >
      {showHistory ? <PanelLeftCloseIcon /> : <><PanelLeftOpenIcon />运行记录</>}
    </Button>
  );

  useEffect(() => {
    // Consumed once mounted: the initial render may have been retried.
    const requested = takeRequestedRun();
    if (requested) setRunId(requested);
    return onRunRequested((next) => setRunId(takeRequestedRun() ?? next));
  }, []);
  // Follow a newly started run (single run or the current batch item).
  const followed = useRef<string | undefined>(activeRunId(run));
  useEffect(() => {
    if (!isActiveRun(run) || followed.current === run.runId) return;
    followed.current = run.runId;
    setRunId(run.runId);
  }, [run]);

  const live = Boolean(runId && run?.runId === runId && isActiveRun(run));
  return (
    <div
      className="grid h-full min-h-0 overflow-hidden bg-surface-0"
      style={{ gridTemplateColumns: showHistory ? `${left.width}px 1px minmax(0,1fr)` : "minmax(0,1fr)" }}
    >
      {showHistory && (
        <>
          <aside aria-label="运行记录" className="flex min-h-0 min-w-0 flex-col bg-surface-1">
            <RunHistory planId={undefined} plans={plans} selectedRunId={runId} onOpenRun={setRunId} />
          </aside>
          <Splitter label="拖拽调整运行记录宽度" {...left.separatorProps} />
        </>
      )}
      <main aria-label="运行监控" className="min-h-0 min-w-0">
        {runId ? (
          <RunMonitor
            key={runId}
            runId={runId}
            run={live && run ? run : undefined}
            live={live}
            historyToggle={historyToggle}
          />
        ) : (
          <EmptyState icon={<ScrollTextIcon />} title="选择一条运行记录" description="在左侧选择运行记录，或在测试编排中启动运行。" />
        )}
      </main>
    </div>
  );
}

function activeRunId(run: TestRunSnapshot | null | undefined): string | undefined {
  return isActiveRun(run) ? run.runId : undefined;
}

function RunMonitor({ runId, run, live, historyToggle }: {
  runId: string;
  run: TestRunSnapshot | undefined;
  live: boolean;
  /** Shows or hides the run history; sits at the start of the title bar. */
  historyToggle: React.ReactNode;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [rejudging, setRejudging] = useState(false);
  const [follow, setFollow] = useState(live);
  const [zoom, setZoom] = useState<TimeRange>();
  const [span, setSpan] = useState<Span>("10000");
  const [marker, setMarker] = useState<number>();
  const [jump, setJump] = useState<ConsoleJump>();
  const [lower, setLower] = useState<Lower>("console");
  const scopeSize = useResizableWidth({
    storageKey: "teststand.run-scope-height",
    defaultWidth: 380,
    min: 160,
    max: () => Math.max(220, window.innerHeight - 280),
    direction: "down"
  });
  const runLog = useRunLog(runId, live);
  const log = runLog.log;
  const trace = useMemo(
    () => log && buildExecutionTrace(log.plan, log.events, log.results, log.run.operations ?? []),
    [log]
  );
  const activeExecutionIds = useMemo(() => (log && trace ? activeExecutions(log, trace) : []), [log, trace]);
  const problemExecutionId = useMemo(
    () => (log && trace ? firstProblemExecution(log, trace) : undefined),
    [log, trace]
  );
  const catalog = useTestStepCatalog().data;
  const outline = useMemo(() => planOutlineEntries(
    trace,
    (type) => catalog?.find((item) => item.type === type)?.label ?? type
  ), [trace, catalog]);
  const stepNames = useMemo(() => new Map([...(trace?.byExecutionId.values() ?? [])].flatMap(
    (node): [string, string][] => node.step.name ? [[node.executionId, node.step.name]] : []
  )), [trace]);
  // Polled while the run is live: the recording grows with every sample the devices deliver (stream
  // extents, decoded messages), and those samples are not events; `testRun` events only mark steps.
  const timeline = useQuery({
    queryKey: queryKeys.testRunTimeline(runId),
    queryFn: () => window.teststand.testing.getRunTimeline({ runId }),
    refetchInterval: live ? 1_000 : false
  });
  const messages = useQuery({
    queryKey: queryKeys.testRunMessages(runId),
    queryFn: () => window.teststand.testing.readRunMessages({ runId }),
    refetchInterval: live ? 2_000 : false
  });
  // One last read once the run ends, so the final windows, stream extents and decoded fields show.
  useEffect(() => {
    if (live) return;
    void client.invalidateQueries({ queryKey: queryKeys.testRunTimeline(runId) });
    void client.invalidateQueries({ queryKey: queryKeys.testRunMessages(runId) });
  }, [client, live, runId]);
  useEffect(() => { setFollow(live); if (live) setZoom(undefined); }, [live]);

  const data = timeline.data;
  // The recording for ranges and records; live frames while the run follows its newest data.
  const source = useMemo<StreamSource>(() => ({
    window: (keys, t0, t1, width) => window.teststand.streams.window({ runId, keys, t0, t1, width }),
    records: (key, query) => window.teststand.testing.readRunStream({ runId, key, ...(query ? { query } : {}) }),
    ...(live ? { live: window.teststand.streams.live } : {})
  }), [runId, live]);
  const range = useMemo(() => runRange(data), [data]);
  const origin = data?.tb0 ?? undefined;
  const following = live && follow;
  const whole = span === "all" && origin !== undefined;
  const spanMs = span === "all" ? 60_000 : Number(span);
  const from = whole ? origin - PRE_ROLL_MS : undefined;
  const shown = following ? undefined : zoom ?? range;
  const now = Date.now();
  const view: TimeRange | undefined = following ? [from ?? now - spanMs, now] : shown;
  const instruments = live || Boolean(data?.streams.length) || Boolean(data?.calls.length);
  const decoded = messages.data?.bindings.length ? messages.data : undefined;
  const lowerShown: Lower = decoded ? lower : "console";
  const results = useMemo(() => resultConsoleEntries(log?.results ?? [], data), [log?.results, data]);
  const select = (next: TimeRange) => {
    setFollow(false);
    setZoom(next);
  };
  const reset = () => {
    setZoom(undefined);
    if (live) setFollow(true);
  };
  const pick = (tb: number, source: PickSource) => {
    setMarker(tb);
    if (source !== "console" && source !== "messages") setJump((current) => ({ tb, seq: (current?.seq ?? 0) + 1 }));
    if (source === "scope") return;
    // Bring the picked instant into view, keeping the current zoom width.
    const width = view ? view[1] - view[0] : spanMs;
    if (following || !view || tb < view[0] || tb > view[1]) select([tb - width / 2, tb + width / 2]);
  };
  /** Zooms the instruments to the time a step ran and scrolls the console to its start. */
  const zoomStep = (executionId: string | undefined) => {
    const stepped = stepRange(data, executionId);
    if (!stepped) return;
    select(stepped);
    const start = data?.steps.find((step) => step.executionId === executionId)?.tb0;
    if (start != null) {
      setMarker(start);
      setJump((current) => ({ tb: start, seq: (current?.seq ?? 0) + 1 }));
    }
  };
  const refreshRun = () => {
    void client.invalidateQueries({ queryKey: queryKeys.testRun });
    void client.invalidateQueries({ queryKey: queryKeys.testItemStatus });
  };
  const rejudge = async () => {
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

  const actions = (
    <>
      {live && <RunControls run={run} confirm={confirm} onStart={() => undefined} onChanged={refreshRun} />}
      {!live && Boolean(data?.windows.length) && (
        <Button size="xs" variant="outline" disabled={rejudging} onClick={() => void rejudge()}>
          <ListChecksIcon />复核判定
        </Button>
      )}
    </>
  );
  const controls = (
    <>
      {live && (
        <>
          <SegmentedControl<Span>
            label="时间跨度"
            size="xs"
            value={span}
            onChange={(next) => { setSpan(next); if (!following) reset(); }}
            options={SPANS.map((item) => ({ ...item, disabled: item.value === "all" && origin === undefined }))}
          />
          <IconButton
            label={following ? "停止跟随" : "跟随最新数据"}
            size="icon-sm"
            variant="ghost"
            aria-pressed={following}
            onClick={() => (following && view ? select(view) : reset())}
          >
            <CrosshairIcon />
          </IconButton>
        </>
      )}
      <IconButton label="复位缩放" size="icon-sm" disabled={!zoom} onClick={reset}><ZoomOutIcon /></IconButton>
    </>
  );
  const terminal = (
    <BusTerminal
      timeline={data}
      source={source}
      live={live}
      origin={origin}
      jump={jump}
      stepNames={stepNames}
      outline={outline}
      extra={results}
      onPick={(tb) => pick(tb, "console")}
      onStep={zoomStep}
    />
  );
  const lowerPane = (
    <div className="flex min-h-0 min-w-0 flex-col">
      {decoded && (
        <div className="flex h-8 shrink-0 items-center border-b border-line bg-surface-1 px-2">
          <SegmentedControl<Lower>
            label="下方面板"
            size="xs"
            value={lowerShown}
            onChange={setLower}
            options={[
              { value: "console", label: "控制台" },
              { value: "messages", label: `报文 ${decoded.total}` }
            ]}
          />
        </div>
      )}
      <div className={lowerShown === "console" ? "min-h-0 flex-1" : "hidden"}>{terminal}</div>
      {decoded && lowerShown === "messages" && (
        <div className="min-h-0 flex-1">
          <RunMessages data={decoded} origin={origin} jump={jump} onPick={(tb) => pick(tb, "messages")} />
        </div>
      )}
    </div>
  );
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <RunHeader
        state={runLog}
        trace={trace}
        activeExecutionIds={activeExecutionIds}
        problemExecutionId={problemExecutionId}
        following={following}
        onCurrent={reset}
        onProblem={() => zoomStep(problemExecutionId)}
        leading={historyToggle}
        actions={actions}
      />
      {instruments && data && range && origin !== undefined && (
        <RunOverview
          timeline={data}
          stepNames={stepNames}
          range={range}
          origin={origin}
          marker={marker}
          onSelect={select}
          onStep={zoomStep}
          onPick={(tb) => pick(tb, "overview")}
        />
      )}
      {/* One tree whether or not the scope shows, so the console keeps its lines and filters. */}
      <section
        aria-label={instruments ? "运行信号" : undefined}
        className="grid min-h-0 min-w-0 flex-1"
        style={{ gridTemplateRows: instruments ? `${scopeSize.width}px 1px minmax(0,1fr)` : "minmax(0,1fr)" }}
      >
        {instruments && (
          <div className="min-h-0 min-w-0 bg-surface-0">
            <SignalScope
              timeline={data}
              source={source}
              live={live}
              follow={following}
              spanMs={spanMs}
              from={from}
              range={shown}
              origin={origin}
              marker={marker}
              syncKey={`run:${runId}`}
              controls={controls}
              emptyText={live ? "本次运行尚未记录波形数据" : "本次运行没有记录波形数据"}
              onPick={(tb) => pick(tb, "scope")}
              onSelectRange={select}
              onReset={reset}
            />
          </div>
        )}
        {instruments && <Splitter label="拖拽调整示波器高度" {...scopeSize.separatorProps} />}
        {lowerPane}
      </section>
      {confirmDialog}
    </div>
  );
}

function stepRange(timeline: RunTimeline | undefined, executionId: string | undefined): TimeRange | undefined {
  const step = timeline?.steps.find((item) => item.executionId === executionId);
  if (step?.tb0 == null) return undefined;
  const end = step.tb1 ?? Date.now();
  const pad = Math.max(50, (end - step.tb0) * 0.1);
  return [step.tb0 - pad, end + pad];
}
