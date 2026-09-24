import type { ReactNode } from "react";
import type { Hardware } from "@hardwareharness/contracts/devices";
import { CircleAlertIcon, SearchXIcon } from "lucide-react";
import { Badge, EmptyState, PanelBody, PanelHeader, Section, type Tone } from "../../../ui";
import { HardwareImage } from "../HardwareImage.js";

/** Inspector frame: nameplate header (name, status, actions) above stacked sections. Ids live in 基本信息. */
export function InspectorShell({ title, status, actions, notice, children }: {
  title: string;
  status?: { label: string; tone: Tone; title?: string | undefined } | undefined;
  actions: ReactNode;
  /** Error strip shown directly under the header (failed action). */
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <PanelHeader actions={actions} className="h-10">
        <h2 className="min-w-0 truncate text-sm font-semibold text-fg">{title}</h2>
        {status && <Badge tone={status.tone} title={status.title}>{status.label}</Badge>}
      </PanelHeader>
      {notice}
      <PanelBody>{children}</PanelBody>
    </>
  );
}

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

/** Appearance photo and the port/pin table of one hardware record. */
export function HardwareSections({ hardware }: { hardware: Hardware }) {
  const pinCount = hardware.ports.reduce((total, port) => total + port.pins.length, 0);
  return (
    <>
      {hardware.appearanceAssetId && (
        <Section title="外观图">
          <figure className="overflow-hidden rounded-md border border-line bg-surface-0">
            <HardwareImage
              hardwareId={hardware.hardwareId}
              assetId={hardware.appearanceAssetId}
              alt={`${hardware.label} 外观图`}
              className="mx-auto max-h-[280px] w-full"
            />
          </figure>
        </Section>
      )}
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
            {port.imageAssetId && (
              <HardwareImage
                hardwareId={hardware.hardwareId}
                assetId={port.imageAssetId}
                alt={`${port.name} 端口图`}
                className="mx-2 mt-2 max-h-[160px] rounded-sm"
              />
            )}
            {port.pins.length > 0 && (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-3 px-2 py-1.5 text-xs">
                {port.pins.map((pin) => (
                  <li className="flex h-5 min-w-0 items-center gap-2" key={pin.pinId} title={`位置 ${pin.position}`}>
                    <code className="tf-num text-fg">{pin.pinId}</code>
                    {pin.label && <span className="truncate text-fg-2">{pin.label}</span>}
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

export function Missing({ title }: { title: string }) {
  return <EmptyState icon={<SearchXIcon />} title={title} description="它可能已被删除。请从左侧重新选择。" />;
}
