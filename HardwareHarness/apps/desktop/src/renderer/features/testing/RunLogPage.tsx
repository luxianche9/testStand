import { useState } from "react";
import { ScrollTextIcon } from "lucide-react";
import { EmptyState, Splitter } from "../../ui";
import { useResizableWidth } from "../../lib/resizable.js";
import { useCurrentTestRun, useTestItemStatus } from "../../lib/queries.js";
import { isActiveRun } from "./plan-helpers.js";
import { RunHistory } from "./RunHistory.js";
import { TestRunLogPage } from "./TestRunLogPage.js";

/** 运行日志: history of every test run on the left, the selected run's log on the right. */
export function RunLogPage() {
  const status = useTestItemStatus();
  const currentRun = useCurrentTestRun();
  const [runId, setRunId] = useState<string>();
  const left = useResizableWidth({
    storageKey: "hardwareharness.run-log-sidebar-width", defaultWidth: 360, min: 260, max: 640, direction: "right"
  });
  const plans = (status.data?.items ?? []).map((item) => ({ id: item.planId, name: item.name }));
  const run = currentRun.data;
  const live = Boolean(runId && run?.runId === runId && isActiveRun(run));

  return (
    <div
      className="grid h-full min-h-0 overflow-hidden bg-surface-0"
      style={{ gridTemplateColumns: `${left.width}px 1px minmax(0,1fr)` }}
    >
      <aside aria-label="运行记录" className="flex min-h-0 min-w-0 flex-col bg-surface-1">
        <RunHistory planId={undefined} plans={plans} selectedRunId={runId} onOpenRun={setRunId} />
      </aside>
      <Splitter label="拖拽调整运行记录宽度" {...left.separatorProps} />
      <main aria-label="运行日志" className="min-h-0 min-w-0">
        {runId ? <TestRunLogPage key={runId} runId={runId} live={live} /> : (
          <EmptyState icon={<ScrollTextIcon />} title="选择一条运行记录" description="在左侧选择运行记录以查看步骤日志。" />
        )}
      </main>
    </div>
  );
}
