import type { StreamInfo, StreamWindow } from "@teststand/contracts/observability";
import { cn } from "../../ui";
import { DisplayMenu, type ChannelDisplay } from "./channel-display.js";
import {
  bitsWidth, codeText, deviceName, maskBits, pointAt, pointMask, pointText, streamUnit
} from "./stream-model.js";

export interface PanelChannel {
  stream: StreamInfo;
  color: string;
}

/**
 * Status panel of the scope: every shown channel as an instrument at the cursor (or the newest
 * reading while following) — a number for analog channels, and for bits channels lamps, relay
 * contacts or the code, as the plugin suggests or the user picked.
 */
export function StatePanel({ channels, reads, at, displayOf, onDisplay }: {
  channels: PanelChannel[];
  reads: Readonly<Record<string, StreamWindow>>;
  at: number | undefined;
  displayOf: (stream: StreamInfo) => ChannelDisplay;
  onDisplay: (stream: StreamInfo, next: Partial<ChannelDisplay>) => void;
}) {
  if (!channels.length) return null;
  return (
    <section
      aria-label="状态面板"
      className={cn(
        "flex max-h-[45%] shrink-0 flex-wrap content-start gap-2 overflow-y-auto",
        "border-b border-line bg-surface-0 p-2"
      )}
    >
      {channels.map(({ stream, color }) => {
        const points = reads[stream.key]?.points;
        const point = at === undefined ? points?.at(-1) : pointAt(points, at);
        const name = stream.declaration?.label ?? stream.streamId;
        const bits = stream.type === "bits";
        const display = bits ? displayOf(stream) : undefined;
        return (
          <article
            key={stream.key}
            aria-label={`${deviceName(stream.hardwareId)} ${name}`}
            className="min-w-36 rounded-md border border-line bg-surface-1 px-2 py-1.5"
          >
            <header className="flex items-center gap-1.5 text-2xs">
              <span aria-hidden className="h-0.5 w-3 shrink-0" style={{ background: color }} />
              <span className="truncate font-medium text-fg" title={`${stream.hardwareId}/${stream.streamId}`}>
                {name}
              </span>
              <span className="truncate text-fg-3">{deviceName(stream.hardwareId)}</span>
              {stream.declaration?.kind === "setpoint" && <span className="text-invalid">设定值</span>}
              {display && (
                <span className="ml-auto">
                  <DisplayMenu stream={stream} display={display} onChange={(next) => onDisplay(stream, next)} />
                </span>
              )}
            </header>
            {display
              ? (
                <BitsState
                  stream={stream}
                  mask={pointMask(point)}
                  width={bitsWidth(stream, points)}
                  mode={display.state}
                />
              )
              : (
                <div className="tf-num mt-1 font-mono text-xl leading-6 text-fg">
                  {pointText(String(stream.type), point)}
                  {streamUnit(stream) && <span className="ml-1 text-xs text-fg-3">{streamUnit(stream)}</span>}
                </div>
              )}
          </article>
        );
      })}
    </section>
  );
}

function BitsState({ stream, mask, width, mode }: {
  stream: StreamInfo;
  mask: number | undefined;
  width: number;
  mode: ChannelDisplay["state"];
}) {
  if (mask === undefined) return <div className="mt-1 text-xs text-fg-3">暂无数据</div>;
  const code = codeText(mask, width, stream.declaration?.codeLabels);
  if (mode === "code") {
    return (
      <div className="mt-1 grid gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="tf-num font-mono text-xl leading-6 text-fg">{code.hex}</span>
          {code.name && (
            <span className="rounded-sm bg-signal/15 px-1.5 text-xs font-medium text-signal">{code.name}</span>
          )}
        </div>
        <div className="tf-num font-mono text-2xs text-fg-3">
          {code.dec} · {code.bin}
        </div>
      </div>
    );
  }
  const labels = stream.declaration?.bitLabels;
  const lines = maskBits(mask, width);
  const on = lines.filter(Boolean).length;
  return (
    <div className="mt-1 grid gap-1">
      <div className="flex flex-wrap gap-x-1.5 gap-y-1">
        {lines.map((high, bit) => {
          const label = labels?.[bit] ?? String(bit);
          const state = mode === "switches" ? (high ? "闭合" : "断开") : (high ? "1" : "0");
          return (
            <div key={bit} title={`${label} = ${state}`} className="grid w-7 justify-items-center gap-0.5">
              {mode === "switches" ? <Contact closed={high} /> : <Lamp lit={high} />}
              <span className={cn("max-w-7 truncate font-mono text-[9px] leading-3", high ? "text-fg" : "text-fg-3")}>
                {label}
              </span>
            </div>
          );
        })}
      </div>
      <div className="tf-num font-mono text-2xs text-fg-3">
        {mode === "switches" ? `闭合 ${on}/${width}` : `亮 ${on}/${width}`} · {code.hex}
      </div>
    </div>
  );
}

function Lamp({ lit }: { lit: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-3 rounded-full border transition-colors duration-120",
        lit ? "border-pass bg-pass shadow-[0_0_6px_var(--tf-pass)]" : "border-line-strong bg-surface-0"
      )}
    />
  );
}

/** A switch contact: two terminals, the blade down on the right one when closed. */
function Contact({ closed }: { closed: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 24 12" className={cn("h-3 w-6", closed ? "text-pass" : "text-fg-3")}>
      <circle cx="4" cy="8" r="1.6" fill="currentColor" />
      <circle cx="20" cy="8" r="1.6" fill="currentColor" />
      <line
        x1="4" y1="8" x2={closed ? 20 : 18} y2={closed ? 8 : 1.5}
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
      />
    </svg>
  );
}
