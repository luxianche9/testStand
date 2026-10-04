import type { ReactNode } from "react";
import type { Hardware } from "@teststand/contracts/devices";
import { CircleAlertIcon, SearchXIcon } from "lucide-react";
import { Badge, EmptyState, PanelBody, PanelHeader, Section, type Tone } from "../../ui";

/** Two-column key/value list; values are mono so ids and addresses line up. */
export function Meta({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {items.map((item) => (
        <div className="contents" key={item.label}>
          <dt className="text-fg-3">{item.label}</dt>
          <dd className="tf-num min-w-0 break-all text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ErrorStrip({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-fail/30 bg-fail/10 px-3 py-1.5 text-xs text-fail"
    >
      <CircleAlertIcon className="mt-0.5 size-3.5 flex-none" />
      <span className="min-w-0 break-words whitespace-pre-wrap">{message}</span>
    </div>
  );
}

/** The port/pin table of one hardware record. */
export function HardwareSections({ hardware }: { hardware: Hardware }) {
  const pinCount = hardware.ports.reduce((total, port) => total + port.pins.length, 0);
  return (
    <>
      <Section
        title="端口"
        actions={<span className="tf-num text-2xs text-fg-3">{hardware.ports.length} 端口 · {pinCount} 针</span>}
      >
        {hardware.ports.length === 0 && <p className="text-xs text-fg-3">还没有登记端口。</p>}
        {hardware.ports.map((port) => (
          <article key={port.portId} className="rounded-md border border-line">
            <header className="flex h-7 items-center gap-2 border-b border-line bg-surface-2/50 px-2">
              <strong className="text-xs font-medium text-fg">{port.name}</strong>
              {!port.name.includes(port.portId) && <span className="tf-num text-2xs text-fg-3">{port.portId}</span>}
              <Badge className="ml-auto" mono>{port.pins.length ? `${port.pins.length} 针` : "无针脚"}</Badge>
            </header>
            {port.pins.length > 0 && (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-3 px-2 py-1.5 text-xs">
                {port.pins.map((pin) => (
                  <li
                    className="flex h-5 min-w-0 items-center gap-2"
                    key={pin.pinId}
                    title={`${pin.pinId} · 位置 ${pin.position}${pin.label ? ` · ${pin.label}` : ""}`}
                  >
                    <code className="tf-num min-w-0 truncate text-fg">{shortPinId(port.portId, pin.pinId)}</code>
                    {pin.label && <span className="min-w-0 truncate text-fg-2">{pin.label}</span>}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </Section>
    </>
  );
}

/** Pin IDs are often qualified with the port ID; drop that prefix for display. */
function shortPinId(portId: string, pinId: string): string {
  return pinId.startsWith(`${portId}.`) ? pinId.slice(portId.length + 1) : pinId;
}
