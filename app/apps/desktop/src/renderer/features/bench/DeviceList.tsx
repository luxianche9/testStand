import { useMemo, useState, type ReactNode } from "react";
import type { Hardware } from "@teststand/contracts/devices";
import type { StreamRef } from "@teststand/contracts/monitor";
import type { DeviceStream } from "@teststand/contracts/observability";
import {
  BoxIcon, CheckIcon, ChevronRightIcon, CpuIcon, PlusIcon, RotateCwIcon, SlidersHorizontalIcon
} from "lucide-react";
import { hardwareStatus } from "../../lib/hardware-status.js";
import { useDashboard, useDevicePackages, useMonitorStreams } from "../../lib/queries.js";
import { Button, IconButton, Panel, PanelBody, StatusLamp, cn, type Tone } from "../../ui/index.js";
import { STREAM_MIME, streamKey } from "../monitor/use-monitor-channels.js";
import { HARDWARE_MIME } from "../wiring/WiringCanvas.js";

const statusTone: Record<ReturnType<typeof hardwareStatus>["tone"], Tone> = {
  ok: "pass",
  warn: "run",
  bad: "fail",
  muted: "neutral"
};

const TYPE_LABELS: Record<string, string> = {
  scalar: "模拟", bits: "位", bytes: "字节", frames: "帧", block: "采样块", blob: "文件", events: "事件"
};

const rowClass = cn(
  "flex h-8 w-full items-center gap-2 pr-2 pl-1.5 text-left outline-none",
  "transition-colors duration-120 hover:bg-surface-2 active:bg-surface-3",
  "focus-visible:bg-surface-2 focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-signal"
);

/**
 * 设备管理 of 测试台架: devices (plugin instances) and passive parts. A click opens a device's
 * information; a row is dragged onto the 端口连线 canvas to place its card. A device expands to the
 * data streams it declares, which are dragged (or added with +) onto 运行监控. A device's actions
 * open from its control button.
 */
export function DeviceList({ hardware, shown, placed, header, footer, onOpen, onControl, onAddStream, ...props }: {
  hardware: Hardware[];
  /** Streams on 运行监控, by `<hardwareId>__<streamId>`. */
  shown: ReadonlySet<string>;
  /** Hardware already carded on the 端口连线 canvas. */
  placed: ReadonlySet<string>;
  header: ReactNode;
  footer?: ReactNode;
  onOpen: (hardware: Hardware) => void;
  onControl: (hardwareId: string, anchor: DOMRect) => void;
  onAddStream: (stream: StreamRef) => void;
  id?: string;
  role?: string;
}) {
  const dashboard = useDashboard();
  const packages = useDevicePackages();
  const declared = useMonitorStreams();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const availability = useMemo(
    () => new Map((dashboard.data?.availability ?? []).map((item) => [item.hardwareId, item])),
    [dashboard.data]
  );
  const streamsOf = useMemo(
    () => new Map((declared.data ?? []).map((item) => [item.hardwareId, item])),
    [declared.data]
  );
  const statusOf = (item: Hardware) => {
    if (item.kind !== "managed") return undefined;
    const instance = dashboard.data?.deviceStatuses.find((entry) => entry.deviceId === item.deviceId);
    const status = hardwareStatus(instance, availability.get(item.hardwareId));
    return { label: status.label, tone: statusTone[status.tone], title: status.title, pulse: status.tone === "warn" };
  };
  const toggle = (hardwareId: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(hardwareId)) next.delete(hardwareId); else next.add(hardwareId);
    return next;
  });
  const groups = [
    { key: "managed", title: "设备", empty: "还没有设备。点上方「+」→「添加设备…」，选择设备的设备包（.tsdev）。",
      items: hardware.filter((item) => item.kind === "managed") },
    { key: "passive", title: "被测件 / 夹具", empty: "被测板、转接箱等不受控的硬件，登记端口和针脚用于接线。",
      items: hardware.filter((item) => item.kind !== "managed") }
  ];
  return (
    <Panel as="aside" aria-label="设备列表" className="min-h-0" {...props}>
      {header}
      {packages.data?.restartRequired && (
        <div
          role="status"
          className={cn(
            "mx-2 mt-2 flex items-center gap-2 rounded-md border border-line bg-surface-2",
            "px-2.5 py-1.5 text-xs leading-5 text-fg-2"
          )}
        >
          <span className="min-w-0 flex-1">设备驱动已更新，重启 testStand 后生效。</span>
          <Button size="sm" onClick={() => void window.teststand.window.relaunch()}>
            <RotateCwIcon />重启
          </Button>
        </div>
      )}
      <PanelBody className="py-1">
        {groups.map((group) => (
          <section key={group.key} aria-label={group.title} className="pb-1">
            <h3 className="tf-label flex h-6 items-center gap-1.5 px-3 text-fg-3">
              {group.title}<span className="tf-num">{group.items.length}</span>
            </h3>
            {group.items.length === 0 && <p className="px-3 pb-2 text-xs leading-5 text-fg-3">{group.empty}</p>}
            <ul className="grid grid-cols-[minmax(0,1fr)]">
              {group.items.map((item) => {
                const status = statusOf(item);
                const managed = item.kind === "managed";
                const expanded = open.has(item.hardwareId);
                const entry = streamsOf.get(item.hardwareId);
                return (
                  <li key={item.hardwareId}>
                    <div
                      className="group flex items-center"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(HARDWARE_MIME, item.hardwareId);
                        event.dataTransfer.effectAllowed = "move";
                      }}
                    >
                      {managed ? (
                        <IconButton
                          label={`${expanded ? "收起" : "展开"} ${item.label} 的数据流`}
                          size="icon-xs"
                          variant="ghost"
                          aria-expanded={expanded}
                          className="ml-1"
                          onClick={() => toggle(item.hardwareId)}
                        >
                          <ChevronRightIcon className={cn("transition-transform", expanded && "rotate-90")} />
                        </IconButton>
                      ) : <span className="ml-1 w-5 shrink-0" />}
                      <button
                        type="button"
                        onClick={() => onOpen(item)}
                        title={placed.has(item.hardwareId)
                          ? `${item.label}（已在端口连线画布上）：单击查看信息`
                          : `${item.label}：单击查看信息，拖到端口连线画布上放置`}
                        className={cn(rowClass, "min-w-0 flex-1 cursor-grab")}
                      >
                        <span className={cn("grid size-5 shrink-0 place-items-center rounded-sm border",
                          "border-line bg-surface-0 text-fg-3")}>
                          {managed ? <CpuIcon className="size-3" /> : <BoxIcon className="size-3" />}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">{item.label}</span>
                        {placed.has(item.hardwareId) && (
                          <CheckIcon aria-label="已在画布上" className="size-3 shrink-0 text-fg-3" />
                        )}
                        {status && (
                          <span title={status.title} className="flex shrink-0 items-center gap-1.5 text-2xs text-fg-2">
                            <StatusLamp tone={status.tone} pulse={status.pulse} />{status.label}
                          </span>
                        )}
                      </button>
                      {managed && (
                        <IconButton label={`控制 ${item.label}`} size="icon-sm" variant="ghost" className="mr-1"
                          onClick={(event) => onControl(item.hardwareId, event.currentTarget.getBoundingClientRect())}>
                          <SlidersHorizontalIcon />
                        </IconButton>
                      )}
                    </div>
                    {managed && expanded && (
                      <StreamRows
                        hardwareId={item.hardwareId}
                        label={item.label}
                        known={entry?.known ?? false}
                        streams={entry?.streams ?? []}
                        shown={shown}
                        onAdd={onAddStream}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </PanelBody>
      {footer}
    </Panel>
  );
}

/** The data streams a device declares, each dragged (or added with +) onto the monitor panel. */
function StreamRows({ hardwareId, label, known, streams, shown, onAdd }: {
  hardwareId: string;
  label: string;
  known: boolean;
  streams: DeviceStream[];
  shown: ReadonlySet<string>;
  onAdd: (stream: StreamRef) => void;
}) {
  if (!known || !streams.length) {
    return (
      <p className="pb-1.5 pl-10 text-2xs text-fg-3">
        {known ? "这台设备没有声明数据流" : "设备连接后显示它声明的数据流"}
      </p>
    );
  }
  return (
    <ul aria-label={`${label} 的数据流`} className="pb-1">
      {streams.map((stream) => {
        const ref = { hardwareId, streamId: stream.id };
        const on = shown.has(streamKey(ref));
        const name = typeof stream.label === "string" && stream.label ? stream.label : stream.id;
        const width = typeof stream.width === "number" && stream.width > 1 ? stream.width : "";
        const unit = typeof stream.unit === "string" ? stream.unit : "";
        return (
          <li
            key={stream.id}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(STREAM_MIME, JSON.stringify(ref));
              event.dataTransfer.effectAllowed = "copy";
            }}
            title={`${hardwareId}/${stream.id}：拖到运行监控查看`}
            className="group/stream flex h-6 cursor-grab items-center gap-2 pr-2 pl-10 text-2xs hover:bg-surface-2"
          >
            <span className="min-w-0 flex-1 truncate text-fg">{name}</span>
            <span className="shrink-0 font-mono text-fg-3">{stream.id}</span>
            <span className="shrink-0 text-fg-3">
              {TYPE_LABELS[stream.type] ?? stream.type}{width}{unit && ` ${unit}`}
            </span>
            {on ? (
              <CheckIcon aria-label="已在运行监控上" className="size-3 shrink-0 text-pass" />
            ) : (
              <IconButton label={`把 ${stream.id} 加到运行监控`} size="icon-xs" variant="ghost"
                className="invisible group-hover/stream:visible" onClick={() => onAdd(ref)}>
                <PlusIcon />
              </IconButton>
            )}
          </li>
        );
      })}
    </ul>
  );
}
