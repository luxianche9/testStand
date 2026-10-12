import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  ActivityIcon, BinaryIcon, ChevronDownIcon, ChevronRightIcon, DatabaseIcon, PlusIcon, TerminalIcon
} from "lucide-react";
import type { DeviceStreams, StreamRef } from "@teststand/contracts/monitor";
import { cn, IconButton, Input } from "../../../ui/index.js";
import { valueAt } from "../../streams/measure.js";
import { formatNumber, pointMask } from "../../streams/stream-model.js";
import { useStreamsPoints } from "../../streams/useStreamReader.js";
import { PanelFrame, useMonitor, usePanel } from "../panel-kit.js";
import { startStreamDrag, streamKey } from "../use-monitor-workspace.js";
import { PanelEmpty } from "./common.js";

function TypeIcon({ type }: { type: string }) {
  const className = "size-3 shrink-0 text-fg-3";
  if (type === "bits") return <BinaryIcon aria-hidden className={className} />;
  if (type === "bytes" || type === "frames") return <TerminalIcon aria-hidden className={className} />;
  return <ActivityIcon aria-hidden className={className} />;
}

/** The newest value of each stream of an open device (sampled streams only). */
function DeviceRows({ device, filter }: { device: DeviceStreams; filter: string }) {
  const { workspace, source, notify } = useMonitor();
  const streams = device.streams.filter((stream) => !filter || stream.id.toLowerCase().includes(filter)
    || String(stream.label ?? "").toLowerCase().includes(filter));
  const sampled = streams.filter((stream) => ["scalar", "block", "bits"].includes(String(stream.type)));
  const points = useStreamsPoints(source, sampled.map((stream) => `${device.hardwareId}__${stream.id}`),
    { follow: true, spanMs: 2_000, range: undefined, width: 50 });
  const shown = new Set(workspace.channels.map(streamKey));
  const add = (ref: StreamRef) => {
    const target = workspace.place(ref);
    if (target) notify.success(`${ref.streamId} 已加到「${target}」`);
    else notify.error(`还没有能显示 ${ref.streamId} 的组件：先从组件栏拖一个进来`);
  };
  return (
    <ul>
      {streams.map((stream) => {
        const ref = { hardwareId: device.hardwareId, streamId: stream.id };
        const read = points.reads[`${device.hardwareId}__${stream.id}`]?.points;
        const value = stream.type === "bits"
          ? (pointMask(read?.at(-1)) !== undefined ? `0x${pointMask(read?.at(-1))!.toString(16).toUpperCase()}` : "")
          : formatNumber(valueAt(read, undefined) ?? null);
        return (
          <li key={stream.id} draggable
            onDragStart={(event) => startStreamDrag(event.dataTransfer, ref, String(stream.type))}
            className="group/source flex h-5 cursor-grab items-center gap-1.5 pr-1 pl-6 hover:bg-surface-2">
            <TypeIcon type={String(stream.type)} />
            <span className={cn("truncate font-mono", shown.has(streamKey(ref)) ? "text-fg" : "text-fg-2")}>
              {stream.id}
            </span>
            {typeof stream.label === "string" && <span className="truncate text-fg-3">{stream.label}</span>}
            <span className="tf-num ml-auto shrink-0 font-mono text-fg-3">
              {sampled.includes(stream) && value !== "—"
                ? `${value}${typeof stream.unit === "string" ? ` ${stream.unit}` : ""}` : ""}
            </span>
            <IconButton label={`加入 ${stream.id}`} size="icon-xs" variant="ghost"
              className="opacity-0 group-hover/source:opacity-100 focus-visible:opacity-100"
              onClick={() => add(ref)}>
              <PlusIcon />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Every device and the streams it declares, with their newest values (PlotJuggler's signal tree):
 * drag a stream onto a panel that can show it, or + puts it on the panel last focused (or the first) that can.
 */
export function SourcesPanel({ api }: IDockviewPanelProps) {
  const [{ workspace }, panel] = usePanel(api.id);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  if (!panel) return null;
  const needle = filter.trim().toLowerCase();
  const devices = workspace.devices.filter((device) => !needle || device.streams.some((stream) =>
    stream.id.toLowerCase().includes(needle)) || device.label.toLowerCase().includes(needle));
  return (
    <PanelFrame panel={panel} className="flex flex-col text-2xs">
      <div className="shrink-0 border-b border-line p-1">
        <Input aria-label="搜索数据流" className="h-6 text-2xs" placeholder="搜索设备或数据流" value={filter}
          onChange={(event) => setFilter(event.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-0.5">
        {!devices.length ? <PanelEmpty icon={<DatabaseIcon />} text="没有设备声明数据流" /> : devices.map((device) => {
          const expanded = open.has(device.hardwareId) || Boolean(needle);
          return (
            <section key={device.hardwareId}>
              <button type="button" aria-expanded={expanded}
                className="flex h-5 w-full items-center gap-1 px-1 text-left hover:bg-surface-2"
                onClick={() => setOpen((current) => {
                  const next = new Set(current);
                  if (next.has(device.hardwareId)) next.delete(device.hardwareId); else next.add(device.hardwareId);
                  return next;
                })}>
                {expanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
                <span className="truncate text-fg">{device.label || device.hardwareId}</span>
                <span className="ml-auto text-fg-3">{device.known ? device.streams.length : "未连接"}</span>
              </button>
              {expanded && <DeviceRows device={device} filter={needle} />}
            </section>
          );
        })}
      </div>
    </PanelFrame>
  );
}
