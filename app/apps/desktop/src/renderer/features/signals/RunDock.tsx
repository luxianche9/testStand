import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TestRunSnapshot } from "@teststand/contracts/testing";
import { ChevronDownIcon, ChevronUpIcon, ListChecksIcon, RadioIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import { Button, IconButton, SegmentedControl, useConfirm, useToast } from "../../ui/index.js";
import { BusTerminal, RunOverview, type ConsoleJump } from "../streams/index.js";
import { RunControls } from "../testing/EditorToolbar.js";
import { RunHeader } from "../testing/RunHeader.js";
import { RunMessages } from "../testing/RunMessages.js";
import { stepRange, type RunView } from "../testing/useRunView.js";
import type { SignalTime } from "./signal-data.js";

type Lower = "console" | "messages";

/**
 * The run under the signal view: verdict, progress and controls, an overview of steps, verdicts
 * and calls on the canvas' time axis, and the console of every step, device call and bus record
 * (or the decoded messages). Picking a step zooms every widget to it.
 */
export function RunDock({ view, run, live, replay, time, height, onBackToLive }: {
  view: RunView;
  run: TestRunSnapshot | undefined;
  live: boolean;
  /** A finished run from the history is shown instead of the devices' live data. */
  replay: boolean;
  time: SignalTime;
  height: number;
  onBackToLive: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [lower, setLower] = useState<Lower>("console");
  const [open, setOpen] = useState(true);
  const [jump, setJump] = useState<ConsoleJump>();
  const [rejudging, setRejudging] = useState(false);
  const { timeline, origin, range, decoded } = view;
  const runId = view.runLog.log?.run.runId;
  const lowerShown: Lower = decoded ? lower : "console";

  const zoomStep = (executionId: string | undefined) => {
    const stepped = stepRange(timeline, executionId);
    if (!stepped) return;
    time.select(stepped);
    const start = timeline?.steps.find((step) => step.executionId === executionId)?.tb0;
    if (start != null) {
      time.pick(start);
      setJump((current) => ({ tb: start, seq: (current?.seq ?? 0) + 1 }));
    }
  };
  const pick = (tb: number, scroll: boolean) => {
    time.pick(tb);
    if (scroll) setJump((current) => ({ tb, seq: (current?.seq ?? 0) + 1 }));
  };
  const refreshRun = () => {
    void client.invalidateQueries({ queryKey: queryKeys.testRun });
    void client.invalidateQueries({ queryKey: queryKeys.testItemStatus });
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

  const leading = (
    <>
      <IconButton label={open ? "收起运行面板" : "展开运行面板"} size="icon-sm" variant="ghost" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDownIcon /> : <ChevronUpIcon />}
      </IconButton>
      {replay && (
        <Button size="xs" variant="outline" onClick={onBackToLive}><RadioIcon />返回实时</Button>
      )}
    </>
  );
  const actions = (
    <>
      {live && <RunControls run={run} confirm={confirm} onStart={() => undefined} onChanged={refreshRun} />}
      {!live && Boolean(timeline?.windows.length) && (
        <Button size="xs" variant="outline" disabled={rejudging} onClick={() => void rejudge()}>
          <ListChecksIcon />复核判定
        </Button>
      )}
    </>
  );
  return (
    <section aria-label="运行面板" className="flex min-h-0 flex-col border-t border-line-strong bg-surface-0"
      style={open ? { height } : undefined}>
      <RunHeader
        state={view.runLog}
        trace={view.trace}
        activeExecutionIds={view.activeExecutionIds}
        problemExecutionId={view.problemExecutionId}
        following={time.follow}
        onCurrent={time.reset}
        onProblem={() => zoomStep(view.problemExecutionId)}
        leading={leading}
        actions={actions}
      />
      {open && timeline && range && origin !== undefined && (
        <RunOverview
          timeline={timeline}
          stepNames={view.stepNames}
          range={range}
          origin={origin}
          marker={time.marker}
          onSelect={time.select}
          onStep={zoomStep}
          onPick={(tb) => pick(tb, true)}
        />
      )}
      {open && view.source && (
        <div className="flex min-h-0 flex-1 flex-col">
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
              timeline={timeline}
              source={view.source}
              live={live}
              origin={origin}
              jump={jump}
              stepNames={view.stepNames}
              outline={view.outline}
              extra={view.results}
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
      )}
      {confirmDialog}
    </section>
  );
}
