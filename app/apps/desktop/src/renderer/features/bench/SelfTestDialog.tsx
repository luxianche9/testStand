import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ToolCatalogItem } from "@teststand/contracts/devices";
import { RotateCwIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { Button, cn, Dialog, DialogBody, DialogContent, DialogFooter, Spinner, StatusLamp, toneText } from "../../ui";
import { selfTestReport, type SelfTestReport } from "./self-test.js";

const TIMEOUT_MS = 60_000;
const GRID = "grid grid-cols-[64px_minmax(120px,1fr)_minmax(90px,1fr)_minmax(90px,1fr)] items-center gap-2 px-2";

/**
 * A plugin's self-test: the checks it makes on the card (identity, versions, channel counts,
 * register readback, the rate a stream really reaches), each with what it measured and expected.
 * It only reads, so it runs as soon as the dialog opens. Passing says the plugin and the card
 * agree; the wiring is proved by the acceptance steps in the plugin's README.
 */
export function SelfTestDialog({ tool, hardwareId, deviceLabel, available, onClose }: {
  tool: ToolCatalogItem | undefined;
  hardwareId: string;
  deviceLabel: string;
  available: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={Boolean(tool)} onOpenChange={(open) => { if (!open) onClose(); }}>
      {tool && (
        <DialogContent title={`${deviceLabel} · 自检`} size="lg">
          <SelfTestRun key={`${hardwareId}:${tool.externalName}`} tool={tool} hardwareId={hardwareId}
            available={available} onClose={onClose} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function SelfTestRun({ tool, hardwareId, available, onClose }: {
  tool: ToolCatalogItem;
  hardwareId: string;
  available: boolean;
  onClose: () => void;
}) {
  const run = useMutation({
    mutationFn: async (): Promise<SelfTestReport> => {
      const result = await window.teststand.manual.invokeTool({
        raw: { hardwareId, toolName: tool.externalName, arguments: {}, timeoutMs: TIMEOUT_MS }
      });
      const report = selfTestReport(result.output);
      if (!report) throw new Error("插件返回的不是自检结果");
      return report;
    }
  });
  const started = useRef(false);
  useEffect(() => {
    if (available && !started.current) {
      started.current = true;
      run.mutate();
    }
  }, [available, run]);
  const report = run.data;

  return (
    <>
      <DialogBody className="grid gap-3">
        <p className="text-xs text-fg-2">
          只读检查插件与板卡是否一致，不改变任何输出。接线和输出电压要按插件说明书的“现场验收”步骤实测。
        </p>
        {!available && <p role="alert" className="text-xs text-fail">设备当前不在线，恢复在线后才能自检。</p>}
        {run.isPending && <Spinner label="正在自检" />}
        {run.isError && <p role="alert" className="text-xs break-words text-fail">{errorMessage(run.error)}</p>}
        {report && <SelfTestTable report={report} />}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>关闭</Button>
        <Button variant="primary" disabled={!available || run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? <Spinner /> : <RotateCwIcon />}
          重新自检
        </Button>
      </DialogFooter>
    </>
  );
}

function SelfTestTable({ report }: { report: SelfTestReport }) {
  const failed = report.checks.filter((check) => !check.passed).length;
  const tone = report.passed ? "pass" : "fail";
  return (
    <section aria-label="自检结果" className="overflow-hidden rounded-md border border-line bg-surface-0">
      <header className="flex h-8 items-center gap-2 border-b border-line px-2.5">
        <StatusLamp tone={tone} />
        <strong className={cn("text-sm font-semibold", toneText[tone])}>
          {report.passed ? "自检通过" : `自检未通过：${failed} 项`}
        </strong>
        <span className="tf-num ml-auto text-2xs text-fg-3">
          {report.checks.length} 项{report.durationMs !== undefined && ` · ${Math.round(report.durationMs)} ms`}
          {report.dryRun && " · 模拟器"}
        </span>
      </header>
      <div role="table" aria-label="自检项">
        <div role="row" className={cn(GRID, "h-6 border-b border-line text-2xs font-semibold text-fg-3")}>
          {["结论", "检查项", "测得", "期望"].map((label) => <span key={label} role="columnheader">{label}</span>)}
        </div>
        {report.checks.map((check, index) => {
          const rowTone = check.passed ? "pass" : "fail";
          return (
            <div key={`${check.name}-${index}`} role="row"
              className={cn("border-b border-line/60 py-1 text-xs last:border-b-0", !check.passed && "bg-fail/4")}>
              <div className={GRID}>
                <span role="cell" className={cn("flex items-center gap-1.5 font-medium", toneText[rowTone])}>
                  <StatusLamp tone={rowTone} />{check.passed ? "通过" : "不通过"}
                </span>
                <span role="cell" className="truncate text-fg" title={check.name}>{check.name}</span>
                <span role="cell" className={cn("truncate font-mono", check.passed ? "text-fg" : "text-fail")}
                  title={check.measured}>{check.measured || "—"}</span>
                <span role="cell" className="truncate font-mono text-fg-2" title={check.expected}>
                  {check.expected || "—"}
                </span>
              </div>
              {check.detail && <p className="px-2 pt-0.5 pl-[80px] text-2xs break-words text-fg-3">{check.detail}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
