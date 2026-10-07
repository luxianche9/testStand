import { useMemo, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import type { StreamPoint, StreamWindow } from "@teststand/contracts/observability";
import type { SignalEnd, SignalWriteAction, WidgetSignalNode } from "@teststand/contracts/signals";
import { SendIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { Button, Input, SegmentedControl, Switch, cn, useToast } from "../../ui/index.js";
import {
  analogData, CHANNEL_COLORS, formatNumber, logicData, NO_OVERLAYS, pointMask, StreamScope, StreamTerminal,
  useStreamsPoints, type SeriesStyle, type TerminalMode, type TimeRange
} from "../streams/index.js";
import { useSignalData } from "./signal-data.js";
import type { ResolvedSignal } from "./signal-model.js";

/** A signal a widget is linked to: the end on the canvas and the device stream it resolves to. */
export interface WidgetInput {
  end: SignalEnd;
  linkId: string;
  label: string;
  resolved: ResolvedSignal | undefined;
}

function Hint({ children }: { children: string }) {
  return <p className="grid h-full place-items-center px-3 text-center text-2xs text-fg-3">{children}</p>;
}

/** The points of the given inputs over the canvas' time axis (one read for all of them). */
function usePoints(inputs: WidgetInput[]) {
  const { source, time } = useSignalData();
  const keys = [...new Set(inputs.flatMap((input) => input.resolved ? [input.resolved.key] : []))];
  const { follow, spanMs, from, range } = time;
  return useStreamsPoints(source, keys, { follow, spanMs, from, range });
}

function holdUntil(read: StreamWindow | undefined, range: TimeRange | undefined): number | undefined {
  return range ? Math.min(range[1], read?.watermarkTb ?? range[1]) : undefined;
}

/** One line of a bits stream as its own 0/1 points. */
function bitPoints(points: StreamPoint[], bit: number): StreamPoint[] {
  return points.map((point) => ({ ...point, mask: ((pointMask(point) ?? 0) >> bit) & 1 }));
}

export function ScopeWidget({ inputs }: { inputs: WidgetInput[] }) {
  const { time, syncKey, origin } = useSignalData();
  const points = usePoints(inputs);
  const view = points.range;
  const scalars = inputs.filter((input) => input.resolved?.info.type === "scalar");
  const bits = inputs.filter((input) => input.resolved?.info.type === "bits");
  const analog = useMemo(() => {
    const read = scalars.filter((input) => points.reads[input.resolved!.key]);
    if (!read.length) return undefined;
    const data = analogData(read.map((input) => {
      const item = points.reads[input.resolved!.key];
      return {
        label: input.label,
        points: item?.points ?? [],
        level: input.resolved!.info.declaration?.kind === "setpoint",
        holdUntil: holdUntil(item, view)
      };
    }));
    const styles = read.map((input, index): SeriesStyle => ({
      color: CHANNEL_COLORS[index % CHANNEL_COLORS.length]!,
      stepped: input.resolved!.info.declaration?.kind === "setpoint"
    }));
    return { data, styles };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scalars.map((input) => input.linkId).join(), points.reads, view]);
  const logic = useMemo(() => {
    const read = bits.filter((input) => points.reads[input.resolved!.key]);
    if (!read.length) return undefined;
    const data = logicData(read.map((input) => {
      const item = points.reads[input.resolved!.key];
      const bit = input.resolved!.bit;
      const info = input.resolved!.info;
      return {
        label: input.label,
        points: bit === undefined ? item?.points ?? [] : bitPoints(item?.points ?? [], bit),
        holdUntil: holdUntil(item, view),
        bitLabels: bit === undefined ? info.bitLabels : [info.bitLabels?.[bit] ?? input.label],
        width: bit === undefined ? info.width : 1,
        keepBits: bit === undefined ? (2 ** Math.min(info.width ?? 1, 31)) - 1 : 1
      };
    }));
    const styles = data.owners.map((owner): SeriesStyle => ({
      color: CHANNEL_COLORS[(scalars.length + owner) % CHANNEL_COLORS.length]!, stepped: true
    }));
    return { data, styles };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bits.map((input) => input.linkId).join(), points.reads, view]);

  if (!inputs.length) return <Hint>把信号连到示波器左侧的输入</Hint>;
  if (!inputs.some((input) => input.resolved)) return <Hint>信号还没有连到设备的流</Hint>;
  const follow = time.follow ? { spanMs: time.spanMs, from: time.from } : undefined;
  const common = {
    range: view, follow, origin, marker: time.marker, syncKey, overlays: NO_OVERLAYS,
    onPick: time.pick, onSelectRange: time.select, onReset: time.reset
  };
  const lanes = logic?.data.lanes?.length ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {scalars.length > 0 && (
        <div className="min-h-0 flex-1">
          <StreamScope data={analog?.data} series={analog?.styles} height="fill" timeAxis={!lanes} {...common} />
        </div>
      )}
      {bits.length > 0 && (
        <div className={cn("min-h-0", scalars.length ? "shrink-0" : "flex-1")}
          style={scalars.length ? { height: Math.min(160, 26 + lanes * 18) } : undefined}>
          <StreamScope data={logic?.data} series={logic?.styles} height="fill" {...common} />
        </div>
      )}
    </div>
  );
}

function latest(read: StreamWindow | undefined): StreamPoint | undefined {
  return read?.points?.at(-1);
}

export function ValueWidget({ input }: { input: WidgetInput | undefined }) {
  const points = usePoints(input ? [input] : []);
  if (!input) return <Hint>连接一个模拟量信号</Hint>;
  if (!input.resolved) return <Hint>信号还没有连到设备的流</Hint>;
  const point = latest(points.reads[input.resolved.key]);
  const value = typeof point?.v === "number" ? point.v : undefined;
  return (
    <div className="grid h-full place-content-center gap-1 text-center">
      <span className="tf-num text-2xl font-semibold text-fg">
        {formatNumber(value)}
        <span className="ml-1 text-sm font-normal text-fg-3">{input.resolved.info.unit ?? ""}</span>
      </span>
      <span className="truncate text-2xs text-fg-3">{input.label}</span>
    </div>
  );
}

/** The bit lines a widget shows: one line of a stream, or every line of it. */
function lines(input: WidgetInput): { bit: number; label: string }[] {
  const info = input.resolved?.info;
  if (!info) return [];
  if (input.resolved?.bit !== undefined) {
    const bit = input.resolved.bit;
    return [{ bit, label: info.bitLabels?.[bit] ?? `bit ${bit}` }];
  }
  return Array.from({ length: info.width ?? 8 }, (_, bit) => ({ bit, label: info.bitLabels?.[bit] ?? `bit ${bit}` }));
}

export function LampsWidget({ input }: { input: WidgetInput | undefined }) {
  const points = usePoints(input ? [input] : []);
  if (!input) return <Hint>连接一个位信号</Hint>;
  if (!input.resolved) return <Hint>信号还没有连到设备的流</Hint>;
  const mask = pointMask(latest(points.reads[input.resolved.key]));
  return (
    <ul className="flex flex-wrap content-start gap-x-3 gap-y-1.5 overflow-auto p-2">
      {lines(input).map(({ bit, label }) => {
        const on = mask !== undefined && Boolean(mask & (1 << bit));
        return (
          <li key={bit} className="flex items-center gap-1.5 text-2xs text-fg-2">
            <span
              aria-label={`${label} ${mask === undefined ? "未知" : on ? "高" : "低"}`}
              className={cn(
                "size-2.5 rounded-full border",
                mask === undefined ? "border-line bg-surface-2"
                  : on ? "border-pass bg-pass" : "border-line-strong bg-surface-3"
              )}
            />
            {label}
          </li>
        );
      })}
    </ul>
  );
}

function useSignalWrite(node: WidgetSignalNode) {
  const toast = useToast();
  return useMutation({
    mutationKey: ["signal-write", node.nodeId],
    mutationFn: (input: { end: SignalEnd; action: SignalWriteAction; value: unknown; bit?: number | undefined }) => {
      const bit = input.bit ?? input.end.bit;
      return window.teststand.signals.write({
        input: {
          nodeId: input.end.nodeId,
          handle: input.end.handle,
          ...(bit !== undefined ? { bit } : {}),
          action: input.action,
          value: input.value
        }
      });
    },
    onError: (error) => toast.error(errorMessage(error))
  });
}

export function SwitchWidget({ node, input }: { node: WidgetSignalNode; input: WidgetInput | undefined }) {
  const { writeBlocked } = useSignalData();
  const points = usePoints(input ? [input] : []);
  const write = useSignalWrite(node);
  if (!input) return <Hint>把开关的输出连到一个可写的位信号</Hint>;
  if (!input.resolved) return <Hint>信号还没有连到设备的流</Hint>;
  const mask = pointMask(latest(points.reads[input.resolved.key]));
  const single = input.resolved.bit !== undefined;
  return (
    <ul className="grid content-start gap-1.5 overflow-auto p-2" title={writeBlocked}>
      {lines(input).map(({ bit, label }) => {
        const on = mask !== undefined && Boolean(mask & (1 << bit));
        return (
          <li key={bit} className="flex items-center justify-between gap-2 text-xs text-fg-2">
            <span className="truncate">{label}</span>
            <Switch
              aria-label={label}
              className="nodrag"
              checked={on}
              disabled={Boolean(writeBlocked) || write.isPending || mask === undefined}
              onCheckedChange={(checked) => write.mutate({
                end: input.end, action: "setBit", value: checked, ...(single ? {} : { bit })
              })}
            />
          </li>
        );
      })}
    </ul>
  );
}

export function SetpointWidget({ node, input }: { node: WidgetSignalNode; input: WidgetInput | undefined }) {
  const { writeBlocked } = useSignalData();
  const points = usePoints(input ? [input] : []);
  const write = useSignalWrite(node);
  const [text, setText] = useState("");
  if (!input) return <Hint>把设定值的输出连到一个可写的模拟量信号</Hint>;
  if (!input.resolved) return <Hint>信号还没有连到设备的流</Hint>;
  const point = latest(points.reads[input.resolved.key]);
  const value = Number(text);
  const valid = text.trim() !== "" && Number.isFinite(value);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) write.mutate({ end: input.end, action: "set", value });
  };
  return (
    <form className="grid h-full content-center gap-2 p-2" onSubmit={submit} title={writeBlocked}>
      <span className="text-2xs text-fg-3">
        当前 <span className="tf-num text-fg">{formatNumber(typeof point?.v === "number" ? point.v : undefined)}</span>
        {" "}{input.resolved.info.unit ?? ""}
      </span>
      <span className="flex gap-1.5">
        <Input
          aria-label={`${input.label} 设定值`}
          className="nodrag h-7 min-w-0 flex-1 text-xs"
          inputMode="decimal"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" size="xs" variant="primary" className="nodrag"
          disabled={!valid || Boolean(writeBlocked) || write.isPending}>
          设定
        </Button>
      </span>
    </form>
  );
}

export function TerminalWidget({ node, input }: { node: WidgetSignalNode; input: WidgetInput | undefined }) {
  const { source, live, writeBlocked } = useSignalData();
  const write = useSignalWrite(node);
  const [mode, setMode] = useState<TerminalMode>("text");
  const [text, setText] = useState("");
  if (!input) return <Hint>连接一个字节流或帧信号</Hint>;
  if (!input.resolved) return <Hint>信号还没有连到设备的流</Hint>;
  const resolved = input.resolved;
  const action: SignalWriteAction = mode === "hex" ? "sendHex" : "sendText";
  const canSend = resolved.info.actions.includes(action);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = mode === "hex" ? text.replace(/\s+/g, "").toLowerCase() : text;
    if (value) write.mutate({ end: input.end, action, value }, { onSuccess: () => setText("") });
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-3">{input.label}</span>
        <SegmentedControl<TerminalMode>
          label="显示格式"
          size="xs"
          className="nodrag"
          value={mode}
          onChange={setMode}
          options={[{ value: "text", label: "文本" }, { value: "hex", label: "HEX" }]}
        />
      </div>
      <div className="nowheel nodrag min-h-0 flex-1">
        <StreamTerminal key={resolved.key} source={source} streamKey={resolved.key}
          type={String(resolved.info.type)} live={live} mode={mode} />
      </div>
      {resolved.info.actions.some((item) => item === "sendText" || item === "sendHex") && (
        <form className="flex shrink-0 gap-1.5 border-t border-line p-1.5" onSubmit={submit} title={writeBlocked}>
          <Input
            aria-label={`发送到 ${input.label}`}
            className="nodrag h-7 min-w-0 flex-1 font-mono text-xs"
            placeholder={mode === "hex" ? "01 A5 …" : "文本，不自动换行"}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" size="xs" variant="outline" className="nodrag"
            disabled={!text || !canSend || Boolean(writeBlocked) || write.isPending}>
            <SendIcon />发送
          </Button>
        </form>
      )}
    </div>
  );
}
