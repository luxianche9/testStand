import type { StreamInfo, StreamWindow } from "@teststand/contracts/observability";
import { cn } from "../../ui";
import { bitsWidth, codeText, deviceName, hasBit, pointAt, pointMask } from "./stream-model.js";

/** Clicking line `bit` asks for it `on`; `locked` says why it cannot be switched now. */
export interface LineControl {
  toggle: (bit: number, on: boolean) => void;
  locked?: string | undefined;
}

export interface PanelChannel {
  stream: StreamInfo;
  color: string;
}

const GROUP = 8;
const LIT = "border-pass bg-pass shadow-[0_0_4px] shadow-pass/60";

/**
 * The digital channels as a front panel: one indicator per line — a lamp for DI/DO, a contact for
 * relays (declared `display: "switches"`) — grouped by eight, named by the declared bit labels,
 * showing the state at the cursor (or the newest). The word is given in hex next to the name, with
 * its declared name when it has one. It is the place to read many lines at once; the logic
 * analyser above draws how they changed.
 */
export function DigitalPanel({ channels, reads, at, control }: {
  channels: PanelChannel[];
  reads: Readonly<Record<string, StreamWindow>>;
  at: number | undefined;
  /** How a line of a stream the device drives is switched by clicking it (none: display only). */
  control?: ((stream: StreamInfo) => LineControl | undefined) | undefined;
}) {
  return (
    <div aria-label="数字量" className="grid gap-2 px-2 py-1.5">
      {channels.map(({ stream, color }) => {
        const points = reads[stream.key]?.points;
        const point = at === undefined ? points?.at(-1) : pointAt(points, at);
        const mask = pointMask(point);
        const width = bitsWidth(stream, points);
        const declared = stream.declaration;
        const contacts = declared?.display === "switches";
        const word = mask === undefined ? undefined : codeText(mask, width, declared?.codeLabels);
        const on = mask === undefined ? 0 : Array.from({ length: width }, (_, bit) => hasBit(mask, bit))
          .filter(Boolean).length;
        const groups = Array.from({ length: Math.ceil(width / GROUP) }, (_, index) => index * GROUP);
        const lines = mask === undefined ? undefined : control?.(stream);
        return (
          <section key={stream.key} aria-label={`${stream.streamId} 数字量`} className="grid gap-1">
            <header className="flex items-center gap-2 text-2xs">
              <span aria-hidden className="h-0.5 w-3 shrink-0" style={{ background: color }} />
              <span className="font-mono text-fg">{deviceName(stream.hardwareId)}/{stream.streamId}</span>
              {declared?.label && <span className="truncate text-fg-3">{declared.label}</span>}
              <span className="tf-num ml-auto font-mono text-fg">{word ? word.short : "—"}</span>
              {word?.name && <span className="tf-num font-mono text-fg-3">{word.hex}</span>}
              <span className="tf-num text-fg-3">{contacts ? `${on} 路闭合` : `${on}/${width} 为 1`}</span>
            </header>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {groups.map((first) => (
                <div key={first} className="flex gap-0.5 rounded-sm border border-line bg-surface-0 px-1 py-0.5">
                  {Array.from({ length: Math.min(GROUP, width - first) }, (_, offset) => {
                    const bit = first + offset;
                    const high = mask !== undefined && hasBit(mask, bit);
                    const name = declared?.bitLabels?.[bit] ?? String(bit);
                    const level = high ? "1" : "0";
                    const state = mask === undefined ? "未知" : contacts ? (high ? "闭合" : "断开") : level;
                    const Cell = lines ? "button" : "div";
                    return (
                      <Cell key={bit}
                        title={`${name}：${state}${lines ? (lines.locked ? `（${lines.locked}）` : "，点击切换") : ""}`}
                        {...(lines ? { type: "button" as const, disabled: Boolean(lines.locked),
                          onClick: () => lines.toggle(bit, !high) } : {})}
                        className={cn("grid w-8 justify-items-center gap-0.5 rounded-xs",
                          lines && !lines.locked && "cursor-pointer hover:bg-surface-2",
                          lines?.locked && "opacity-60")}>
                        {contacts ? <Contact closed={high} known={mask !== undefined} /> : (
                          <span
                            aria-label={`${name} ${state}`}
                            className={cn(
                              "size-2.5 rounded-full border",
                              mask === undefined ? "border-line bg-transparent"
                                : high ? LIT : "border-line-strong bg-surface-3"
                            )}
                          />
                        )}
                        <span className="max-w-8 truncate font-mono text-[9px] leading-none text-fg-3">{name}</span>
                      </Cell>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** A relay contact: the blade lies on the contact when closed, lifted when open. */
function Contact({ closed, known }: { closed: boolean; known: boolean }) {
  return (
    <svg viewBox="0 0 20 10" className={cn("h-2.5 w-5", !known ? "text-fg-3" : closed ? "text-pass" : "text-fg-2")}
      aria-label={known ? (closed ? "闭合" : "断开") : "未知"}>
      <circle cx="3" cy="7" r="1.5" fill="currentColor" />
      <circle cx="17" cy="7" r="1.5" fill="currentColor" />
      <line x1="3" y1="7" x2={closed ? 17 : 15} y2={closed ? 7 : 1} stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
