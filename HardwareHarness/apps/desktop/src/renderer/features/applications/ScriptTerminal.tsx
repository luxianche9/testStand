import { useEffect, useId, useRef, useState } from "react";
import type { RunEvent, RunRecord } from "@hardwareharness/contracts/applications";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { errorMessage } from "../../shared/errors.js";

const statusText: Record<RunRecord["status"], string> = {
  running: "运行中", cancelling: "正在停止", succeeded: "运行完成", failed: "运行失败", cancelled: "已停止", interrupted: "运行中断"
};

export function ScriptTerminal({ runId, notice, open, onOpenChange, onRunChange }: {
  runId: string | undefined; notice: string; open: boolean;
  onOpenChange: (open: boolean) => void; onRunChange: (run: RunRecord) => void;
}) {
  const id = useId();
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);

  useEffect(() => {
    setOutput(""); setStatus(""); setError("");
    followOutput.current = true;
    if (!runId) return;
    let stopped = false;
    let pulling = false;
    let after = 0;
    let text = "";
    const api = window.hardwareharness.applications;
    const pull = async () => {
      if (pulling || stopped) return;
      pulling = true;
      try {
        const detail = await api.getRun(runId);
        let events = after === 0 ? detail.events : await api.runEvents(runId, after, 500);
        while (!stopped) {
          const previous = after;
          for (const event of events) {
            if (event.sequence <= after) continue;
            text += eventText(event);
            after = event.sequence;
          }
          // Keep the terminal bounded; the complete record remains in Run Logs.
          text = text.slice(-200_000);
          setOutput(text);
          if (after === previous || after >= detail.run.eventCount) break;
          events = await api.runEvents(runId, after, 500);
        }
        if (stopped) return;
        onRunChange(detail.run);
        setStatus(statusText[detail.run.status]);
        setError(detail.run.error ? runError(detail.run.error) : "");
      } catch (value) { if (!stopped) setError(errorMessage(value)); }
      finally { pulling = false; }
    };
    void pull();
    const stopRun = window.hardwareharness.events.subscribe("run", () => { void pull(); });
    const stopEvent = window.hardwareharness.events.subscribe("runEvent", () => { void pull(); });
    const timer = window.setInterval(() => void pull(), 1000);
    return () => { stopped = true; stopRun(); stopEvent(); window.clearInterval(timer); };
  }, [onRunChange, runId]);

  useEffect(() => { if (open) followOutput.current = true; }, [open]);
  useEffect(() => {
    if (open && followOutput.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [error, notice, open, output, status]);

  return <section aria-label="脚本终端" className={`flex flex-none flex-col border-t border-border ${open ? "h-[30%] min-h-28" : ""}`}>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => onOpenChange(!open)} className="flex h-8 flex-none items-center gap-1.5 px-3 text-left text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}终端
    </button>
    <div id={id} ref={scroll} hidden={!open} role="log" aria-label="脚本终端输出" aria-live="polite" className="min-h-0 flex-1 overflow-auto px-3 pb-3 font-mono text-xs leading-5" onScroll={(event) => {
      const element = event.currentTarget;
      followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    }}>
      <pre className="m-0 whitespace-pre-wrap break-words">{output}</pre>
      {status && <p className="m-0 text-muted-foreground">{status}</p>}
      {(error || notice) && <pre className="m-0 whitespace-pre-wrap break-words text-destructive">{[error, notice].filter(Boolean).join("\n")}</pre>}
    </div>
  </section>;
}

function eventText(event: RunEvent): string {
  if ((event.type === "stdout" || event.type === "stderr") && typeof event.data.text === "string") return event.data.text;
  if (event.type === "log" && typeof event.data.message === "string") return `${event.data.message}\n`;
  if (event.type === "run.completed" && event.data.result !== undefined) return `\n${JSON.stringify(event.data.result, null, 2)}\n`;
  return "";
}

function runError(error: NonNullable<RunRecord["error"]>): string {
  const traceback = (error as { traceback?: unknown }).traceback;
  if (typeof traceback === "string") return traceback;
  const details = error.details as { traceback?: unknown } | undefined;
  return typeof details?.traceback === "string" ? details.traceback : error.message;
}
