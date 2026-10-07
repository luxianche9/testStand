import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TestRunSnapshot } from "@teststand/contracts/testing";
import { ChevronDownIcon, ChevronUpIcon, ListChecksIcon, RadioIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import { onRunStepFocused } from "../../lib/run-focus.js";
import { Button, IconButton, useConfirm, useToast } from "../../ui/index.js";
import type { ConsoleJump } from "../streams/index.js";
import { RunControls } from "../testing/EditorToolbar.js";
import { RunHeader } from "../testing/RunHeader.js";
import { RunMessages } from "../testing/RunMessages.js";
import { stepRange, type RunView } from "../testing/useRunView.js";
import type { SignalTime } from "./signal-data.js";

/**
 * The run under the signal view: verdict, progress and controls, export, and the messages decoded
 * from its bus records. Its steps and their states are the test panel's flow; bus and serial
 * traffic is shown by the terminal widgets on the canvas.
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
  const [open, setOpen] = useState(true);
  const [jump, setJump] = useState<ConsoleJump>();
  const [rejudging, setRejudging] = useState(false);
  const { timeline, origin, decoded } = view;
  const runId = view.runLog.log?.run.runId;

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
  // A step picked in the test panel's flow.
  const zoomRef = useRef(zoomStep);
  zoomRef.current = zoomStep;
  useEffect(() => onRunStepFocused((executionId) => zoomRef.current(executionId)), []);
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
      {decoded && (
        <IconButton label={open ? "收起报文" : "展开报文"} size="icon-sm" variant="ghost" aria-expanded={open}
          onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDownIcon /> : <ChevronUpIcon />}
        </IconButton>
      )}
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
      style={open && decoded ? { height } : undefined}>
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
      {open && decoded && (
        <div className="min-h-0 flex-1">
          <RunMessages data={decoded} origin={origin} jump={jump} onPick={(tb) => pick(tb, false)} />
        </div>
      )}
      {confirmDialog}
    </section>
  );
}
