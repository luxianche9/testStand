import { OctagonXIcon, PlayIcon } from "lucide-react";
import type { TestBatch } from "@hardwareharness/contracts/testing";
import { Button, Label, Switch } from "../../ui";

/** Item-list footer: stop-on-fail beside batch start, and live batch progress with abort. */
export function BatchFooter({ batch, selectedCount, stopOnFail, busy, onStopOnFail, onRunSelected, onAbort }: {
  batch: TestBatch | undefined;
  selectedCount: number;
  stopOnFail: boolean;
  /** Another run or batch is active, so nothing new may start. */
  busy: boolean;
  onStopOnFail: (value: boolean) => void;
  onRunSelected: () => void;
  onAbort: () => void;
}) {
  const running = batch?.state === "running";
  return (
    <div className="grid shrink-0 gap-2 border-t border-line bg-surface-1 p-2">
      {running && batch ? <BatchProgress batch={batch} onAbort={onAbort} /> : (
        <>
          <div className="flex items-center gap-2">
            <Switch id="testing-stop-on-fail" checked={stopOnFail} onCheckedChange={onStopOnFail} />
            <Label htmlFor="testing-stop-on-fail" className="shrink-0 font-normal">失败即停</Label>
            <Button
              size="sm"
              variant="primary"
              className="min-w-0 flex-1"
              disabled={busy || selectedCount === 0}
              onClick={onRunSelected}
            >
              <PlayIcon />运行所选 ({selectedCount})
            </Button>
          </div>
          {batch && <LastBatch batch={batch} />}
        </>
      )}
    </div>
  );
}

function BatchProgress({ batch, onAbort }: { batch: TestBatch; onAbort: () => void }) {
  const done = batch.items.filter((item) => item.state === "done" || item.state === "skipped").length;
  const total = batch.items.length;
  const current = batch.items.find((item) => item.state === "running");
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="size-1.5 animate-lamp rounded-full bg-run" />
        <span className="min-w-0 flex-1 truncate text-fg-2">{current ? current.planName : "批量运行中"}</span>
        <span className="tf-num text-2xs text-fg-3">{done}/{total}</span>
      </div>
      <div
        role="progressbar"
        aria-label="批量运行进度"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-1 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="h-full bg-run transition-[width] duration-300"
          style={{ width: `${total ? Math.round(done / total * 100) : 0}%` }}
        />
      </div>
      <Button size="sm" variant="danger" onClick={onAbort}><OctagonXIcon />中止</Button>
    </div>
  );
}

const batchStateLabels: Record<TestBatch["state"], string> = {
  running: "运行中", completed: "已完成", aborted: "已中止", error: "出错", interrupted: "已中断"
};

function LastBatch({ batch }: { batch: TestBatch }) {
  const text = `上次批量 ${batchStateLabels[batch.state]}`;
  return (
    <span className="truncate text-2xs text-fg-3" title={batch.stopReason ?? text}>{text}</span>
  );
}
