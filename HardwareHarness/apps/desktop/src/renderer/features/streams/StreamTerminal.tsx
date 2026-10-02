import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { StreamRecord } from "@hardwareharness/contracts/observability";
import "@xterm/xterm/css/xterm.css";
import { ansiLine, terminalLine, type TerminalMode } from "./stream-model.js";
import { fontStack, tokenColor, useThemeVersion } from "./theme-colors.js";
import { RECORD_CAP, useStreamRecords, type StreamSource } from "./useStreamReader.js";

/**
 * Read-only terminal of one record stream (bytes TX/RX, frames, events): what the source recorded
 * and, when `live`, the new records as they arrive.
 */
export function StreamTerminal({ source, streamKey, type, live, mode }: {
  source: StreamSource;
  streamKey: string;
  type: string;
  live: boolean;
  mode: TerminalMode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const records = useRef<StreamRecord[]>([]);
  const [failed, setFailed] = useState<string>();
  const theme = useThemeVersion();
  const format = useRef({ type, mode });
  format.current = { type, mode };

  const write = (batch: StreamRecord[]) => {
    const target = terminal.current;
    if (!target || !batch.length) return;
    const { type: kind, mode: display } = format.current;
    target.write(`${batch.map((record) => ansiLine(terminalLine(kind, record, display))).join("\r\n")}\r\n`);
  };

  const state = useStreamRecords(source, streamKey, live, {
    onReset: () => {
      records.current = [];
      terminal.current?.reset();
    },
    onRecords: (batch) => {
      records.current.push(...batch);
      if (records.current.length > RECORD_CAP) records.current.splice(0, records.current.length - RECORD_CAP);
      write(batch);
    }
  });

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xterm, fit]) => {
      if (disposed) return;
      const instance = new xterm.Terminal({
        disableStdin: true,
        convertEol: false,
        cursorBlink: false,
        scrollback: RECORD_CAP,
        fontFamily: fontStack("mono"),
        fontSize: 12,
        theme: {
          background: tokenColor("--tf-surface-1"),
          foreground: tokenColor("--tf-fg"),
          cursor: tokenColor("--tf-surface-1"),
          selectionBackground: tokenColor("--tf-signal", 0.3),
          cyan: tokenColor("--tf-run"),
          green: tokenColor("--tf-pass"),
          yellow: tokenColor("--tf-signal"),
          red: tokenColor("--tf-fail")
        }
      });
      const fitter = new fit.FitAddon();
      instance.loadAddon(fitter);
      instance.open(element);
      instance.write("\x1b[?25l");
      terminal.current = instance;
      fitter.fit();
      write(records.current);
      observer = new ResizeObserver(() => { try { fitter.fit(); } catch { /* Hidden terminals have no size. */ } });
      observer.observe(element);
    }).catch((cause: unknown) => setFailed(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      disposed = true;
      observer?.disconnect();
      terminal.current?.dispose();
      terminal.current = undefined;
    };
  // `write` only reads refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  // A new display mode re-renders everything already received.
  useEffect(() => {
    const target = terminal.current;
    if (!target) return;
    target.reset();
    target.write("\x1b[?25l");
    write(records.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, type]);

  const status = failed ? `终端加载失败：${failed}`
    : state.error ? `读取失败：${state.error}`
      : state.truncated ? `仅显示最近 ${RECORD_CAP} 条` : undefined;
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-surface-1">
      <div ref={host} className="min-h-0 flex-1 overflow-hidden px-1 py-0.5" />
      <div className="flex h-5 shrink-0 items-center gap-2 border-t border-line px-2 text-2xs text-fg-3">
        <span className="tf-num">{state.count} 条</span>
        {status && <span className={state.error || failed ? "truncate text-fail" : "truncate"}>{status}</span>}
      </div>
    </div>
  );
}
