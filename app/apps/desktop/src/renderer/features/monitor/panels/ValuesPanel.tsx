import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Table2Icon } from "lucide-react";
import type { StreamInfo } from "@teststand/contracts/observability";
import { errorMessage } from "../../../lib/errors.js";
import { cn } from "../../../ui/index.js";
import { ScrubNumber } from "../../manual/widgets.js";
import { niceStep } from "../../manual/widget-model.js";
import { measure, sparkline, valueAt } from "../../streams/measure.js";
import { CHANNEL_COLORS, formatNumber, streamUnit } from "../../streams/stream-model.js";
import { useStreamsPoints } from "../../streams/useStreamReader.js";
import { setpointBinding, type SetpointBinding } from "../control-bindings.js";
import { PanelFrame, useMonitor, usePanel, useRemove, useWindow } from "../panel-kit.js";
import { PanelEmpty, readingAt, Sparkline, StreamTitle } from "./common.js";

export interface Limits { lo?: number; hi?: number }

/** Limits per `hardwareId/streamId` from a panel's settings. */
export function limitsOf(settings: Record<string, unknown>, stream: Pick<StreamInfo, "hardwareId" | "streamId">):
  Limits {
  const all = settings.limits;
  const key = `${stream.hardwareId}/${stream.streamId}`;
  const item = all && typeof all === "object" ? (all as Record<string, unknown>)[key] : undefined;
  if (!item || typeof item !== "object") return {};
  const { lo, hi } = item as Record<string, unknown>;
  return { ...(typeof lo === "number" ? { lo } : {}), ...(typeof hi === "number" ? { hi } : {}) };
}

export function outside(value: number | undefined, limits: Limits): boolean {
  return value !== undefined && ((limits.lo !== undefined && value < limits.lo)
    || (limits.hi !== undefined && value > limits.hi));
}

export function unitOf(stream: StreamInfo): string {
  return stream.declaration?.unit ?? streamUnit(stream);
}

/** Sets a setpoint from its row: drag or type, sent when released. */
function SetpointCell({ stream, binding, current }: {
  stream: StreamInfo;
  binding: SetpointBinding;
  current: number | undefined;
}) {
  const { control, notify } = useMonitor();
  const [draft, setDraft] = useState<number>();
  const locked = control.lockOf(stream.hardwareId);
  const send = (value: number) => {
    void control.call(stream.hardwareId, binding.tool, { ...binding.fixed, [binding.value]: value })
      .then(() => setDraft(undefined))
      .catch((cause: unknown) => notify.error(errorMessage(cause)));
  };
  return (
    <span title={locked ?? `用 ${binding.tool} 设定`} className={cn(locked && "opacity-50")}>
      <ScrubNumber
        label={`设定 ${stream.streamId}`}
        value={draft ?? current}
        widget={{
          min: binding.min, max: binding.max, step: niceStep(binding.min, binding.max, false), unit: unitOf(stream)
        }}
        disabled={Boolean(locked)}
        onChange={setDraft}
        onCommit={send}
      />
    </span>
  );
}

/**
 * Many numbers at once (CANoe's Data window): per stream the value now, min / max / mean over the
 * shown window, a sparkline, red when outside its limits. A setpoint row can be set in place.
 */
export function ValuesPanel({ api }: IDockviewPanelProps) {
  const [{ workspace, control }, panel] = usePanel(api.id);
  const view = useWindow();
  const remove = useRemove(panel);
  const streams = panel ? workspace.streamsOf(panel) : [];
  const points = useStreamsPoints(view.source, streams.map((stream) => stream.key), view);
  if (!panel) return null;
  const at = readingAt(view.follow, view.marker);
  return (
    <PanelFrame panel={panel} className="overflow-auto">
      {!streams.length ? <PanelEmpty icon={<Table2Icon />} text="把模拟量拖到这里" /> : (
        <table aria-label="数值" className="w-full border-collapse text-2xs">
          <thead className="sticky top-0 bg-surface-1 text-fg-3">
            <tr className="h-5 text-left [&>th]:px-2 [&>th]:font-normal">
              <th>信号</th><th className="text-right">当前</th><th className="text-right">最小</th>
              <th className="text-right">最大</th><th className="text-right">平均</th><th>趋势</th><th>设定</th>
            </tr>
          </thead>
          <tbody>
            {streams.map((stream, index) => {
              const read = points.reads[stream.key]?.points;
              const stats = measure(read, points.range);
              const now = valueAt(read, at);
              const limits = limitsOf(panel.settings, stream);
              const unit = unitOf(stream);
              const binding = setpointBinding(stream, control.toolsOf(stream.hardwareId));
              return (
                <tr key={stream.key} className="h-5 border-t border-line [&>td]:px-2">
                  <td className="max-w-48">
                    <StreamTitle stream={stream} color={CHANNEL_COLORS[index % CHANNEL_COLORS.length]}
                      onRemove={() => remove(stream)} />
                  </td>
                  <td className={cn("tf-num text-right font-mono text-xs",
                    outside(now, limits) ? "text-fail" : "text-fg")}>
                    {formatNumber(now)} <span className="text-fg-3">{unit}</span>
                  </td>
                  <td className="tf-num text-right font-mono text-fg-2">{formatNumber(stats?.min)}</td>
                  <td className="tf-num text-right font-mono text-fg-2">{formatNumber(stats?.max)}</td>
                  <td className="tf-num text-right font-mono text-fg-2">{formatNumber(stats?.mean)}</td>
                  <td><Sparkline values={sparkline(read, 60)} width={80} /></td>
                  <td>{binding ? <SetpointCell stream={stream} binding={binding} current={now} /> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </PanelFrame>
  );
}
