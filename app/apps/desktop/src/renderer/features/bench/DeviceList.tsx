import { useMemo, type ReactNode } from "react";
import type { Hardware } from "@teststand/contracts/devices";
import { BoxIcon, CheckIcon, CpuIcon } from "lucide-react";
import { hardwareStatus } from "../../lib/hardware-status.js";
import { useDashboard } from "../../lib/queries.js";
import { Panel, PanelBody, StatusLamp, cn, type Tone } from "../../ui/index.js";
import { HARDWARE_MIME } from "../wiring/WiringCanvas.js";

const statusTone: Record<ReturnType<typeof hardwareStatus>["tone"], Tone> = {
  ok: "pass",
  warn: "run",
  bad: "fail",
  muted: "neutral"
};

/** 设备 column of 测试台架: devices (plugin instances) and passive parts. Clicking a row opens its
 *  information; dragging it onto the canvas places it on the bench. */
export function DeviceList({ hardware, placed, header, footer, onOpen, ...props }: {
  hardware: Hardware[];
  placed: Set<string>;
  header: ReactNode;
  footer?: ReactNode;
  onOpen: (hardware: Hardware) => void;
  id?: string;
  role?: string;
}) {
  const dashboard = useDashboard();
  const availability = useMemo(
    () => new Map((dashboard.data?.availability ?? []).map((item) => [item.hardwareId, item])),
    [dashboard.data]
  );
  const statusOf = (item: Hardware) => {
    if (item.kind !== "managed") return undefined;
    const instance = dashboard.data?.deviceStatuses.find((entry) => entry.deviceId === item.deviceId);
    const status = hardwareStatus(instance, availability.get(item.hardwareId));
    return { label: status.label, tone: statusTone[status.tone], title: status.title, pulse: status.tone === "warn" };
  };
  const groups = [
    { key: "managed", title: "设备", empty: "还没有设备。点上方「+」→「添加设备…」，选择设备的设备包（.tsdev）。",
      items: hardware.filter((item) => item.kind === "managed") },
    { key: "passive", title: "被测件 / 夹具", empty: "被测板、转接箱等不受控的硬件，用于接线。",
      items: hardware.filter((item) => item.kind !== "managed") }
  ];
  return (
    <Panel as="aside" aria-label="设备列表" className="min-h-0" {...props}>
      {header}
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
                const onCanvas = placed.has(item.hardwareId);
                return (
                  <li
                    key={item.hardwareId}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(HARDWARE_MIME, item.hardwareId);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => onOpen(item)}
                      title={onCanvas ? `${item.label}（已在画布上）` : `${item.label}：单击查看信息，拖到画布上放置`}
                      className={cn(
                        "flex h-8 w-full cursor-grab items-center gap-2 pr-3 pl-3 text-left outline-none",
                        "transition-colors duration-120 hover:bg-surface-2 active:bg-surface-3",
                        "focus-visible:bg-surface-2 focus-visible:outline-1 focus-visible:-outline-offset-1",
                        "focus-visible:outline-signal"
                      )}
                    >
                      <span className={cn(
                        "grid size-5 shrink-0 place-items-center rounded-sm border border-line bg-surface-0",
                        "text-fg-3"
                      )}>
                        {item.kind === "managed" ? <CpuIcon className="size-3" /> : <BoxIcon className="size-3" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">{item.label}</span>
                      {onCanvas && <CheckIcon aria-label="已在画布上" className="size-3 shrink-0 text-fg-3" />}
                      {status && (
                        <span title={status.title} className="flex shrink-0 items-center gap-1.5 text-2xs text-fg-2">
                          <StatusLamp tone={status.tone} pulse={status.pulse} />{status.label}
                        </span>
                      )}
                    </button>
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
