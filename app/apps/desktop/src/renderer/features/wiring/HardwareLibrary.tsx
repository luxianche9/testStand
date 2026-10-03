import { useMemo, useState, type ReactNode } from "react";
import type { Hardware } from "@teststand/contracts/devices";
import { CheckIcon, CpuIcon, RefreshCwIcon } from "lucide-react";
import { useDashboard } from "../../lib/queries.js";
import { hardwareStatus } from "../../lib/hardware-status.js";
import { IconButton, Panel, PanelBody, PanelHeader, StatusLamp, cn, type Tone } from "../../ui/index.js";

export const HARDWARE_MIME = "application/teststand-hardware";

const statusTone: Record<ReturnType<typeof hardwareStatus>["tone"], Tone> = {
  ok: "pass",
  warn: "run",
  bad: "fail",
  muted: "neutral"
};

type LibraryStatus = { label: string; tone: Tone; title?: string | undefined; pulse?: boolean };

export function HardwareLibrary({ hardware, placed, onAdd, onRefresh, header, ...props }: {
  hardware: Hardware[];
  placed: Set<string>;
  onAdd: (hardwareId: string) => void;
  onRefresh: () => void;
  /** Replaces the default title; receives the refresh control to place in it. */
  header?: (actions: ReactNode) => ReactNode;
  id?: string;
  role?: string;
}) {
  const dashboard = useDashboard();
  const [checking, setChecking] = useState(false);
  // Online state comes from the availability probe, keyed by hardwareId; passive (non-MCP)
  // hardware has no probe and is shown as such rather than "offline".
  const availability = useMemo(
    () => new Map((dashboard.data?.availability ?? []).map((item) => [item.hardwareId, item])),
    [dashboard.data]
  );
  // Passive parts have no probe; their group heading already says what they are.
  const statusOf = (item: Hardware): LibraryStatus | undefined => {
    if (item.kind !== "managed") return undefined;
    const instance = dashboard.data?.deviceStatuses.find((entry) => entry.deviceId === item.deviceId);
    const status = hardwareStatus(instance, availability.get(item.hardwareId));
    return { label: status.label, tone: statusTone[status.tone], title: status.title, pulse: status.tone === "warn" };
  };
  const groups = [
    { key: "managed", title: "受控硬件", items: hardware.filter((item) => item.kind === "managed") },
    { key: "passive", title: "被动器件", items: hardware.filter((item) => item.kind !== "managed") }
  ].filter((group) => group.items.length);

  const check = async () => {
    setChecking(true);
    try {
      await window.teststand.devices.listManagedHardware();
    } catch { /* a half-down MCP still reports per-hardware state below */ }
    await dashboard.refetch();
    onRefresh();
    setChecking(false);
  };

  const refresh = (
    <IconButton label="刷新" size="icon-sm" disabled={checking} onClick={() => void check()}>
      <RefreshCwIcon className={cn(checking && "animate-spin")} />
    </IconButton>
  );

  return (
    <Panel as="aside" aria-label="硬件库面板" className="min-h-0" {...props}>
      {header ? header(refresh) : <PanelHeader title="硬件库" meta={hardware.length} actions={refresh} />}
      <PanelBody className="py-1">
        {groups.map((group) => (
          <section key={group.key} aria-label={group.title} className="pb-1">
            <h3 className="tf-label flex h-6 items-center gap-1.5 px-3 text-fg-3">
              {group.title}<span className="tf-num">{group.items.length}</span>
            </h3>
            <ul className="grid grid-cols-[minmax(0,1fr)]">
              {group.items.map((item) => (
                <LibraryRow
                  key={item.hardwareId}
                  item={item}
                  status={statusOf(item)}
                  onCanvas={placed.has(item.hardwareId)}
                  onAdd={onAdd}
                />
              ))}
            </ul>
          </section>
        ))}
        {!hardware.length && (
          <p className="px-3 py-4 text-xs leading-5 text-fg-3">
            还没有登记设备。请到「设备管理」页登记硬件及其端口。
          </p>
        )}
      </PanelBody>
      {hardware.length > 0 && (
        <p className="shrink-0 border-t border-line px-3 py-1.5 text-2xs text-fg-3">拖到画布或单击加入</p>
      )}
    </Panel>
  );
}

function LibraryRow({ item, status, onCanvas, onAdd }: {
  item: Hardware;
  status: LibraryStatus | undefined;
  onCanvas: boolean;
  onAdd: (hardwareId: string) => void;
}) {
  return (
    <li
      draggable={!onCanvas}
      onDragStart={(event) => {
        event.dataTransfer.setData(HARDWARE_MIME, item.hardwareId);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <button
        type="button"
        disabled={onCanvas}
        onClick={() => onAdd(item.hardwareId)}
        title={onCanvas ? `${item.label} 已在画布上` : `加入画布：${item.label}`}
        className={cn(
          "group flex h-7 w-full items-center gap-2 border-l-2 border-transparent pr-3 pl-[10px] text-left",
          "transition-colors duration-120 outline-none enabled:hover:bg-surface-2 enabled:active:bg-surface-3",
          "focus-visible:bg-surface-2 focus-visible:outline-1 focus-visible:-outline-offset-1",
          "focus-visible:outline-signal disabled:cursor-default",
          !onCanvas && "cursor-grab"
        )}
      >
        <span className="grid size-5 shrink-0 place-items-center rounded-sm border border-line bg-surface-0 text-fg-3">
          <CpuIcon className="size-3" />
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-sm", onCanvas ? "text-fg-2" : "text-fg")}>{item.label}</span>
        {onCanvas && (
          <span className="flex shrink-0 items-center gap-0.5 text-2xs text-fg-3">
            <CheckIcon aria-hidden className="size-3" />已放置
          </span>
        )}
        {status && (
          <span title={status.title} className="flex shrink-0 items-center gap-1.5 text-2xs text-fg-2">
            <StatusLamp tone={status.tone} pulse={status.pulse ?? false} />
            {status.label}
          </span>
        )}
      </button>
    </li>
  );
}
