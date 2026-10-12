import { useEffect, useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import type { StreamInfo } from "@teststand/contracts/observability";
import { EmptyState, IconButton } from "../../../ui/index.js";
import { deviceName } from "../../streams/stream-model.js";
import { streamName } from "../panel-kit.js";

/** The size of an element (attach the returned ref), followed as it changes. */
export function useSize<T extends HTMLElement>(): [(node: T | null) => void, { width: number; height: number }] {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box) setSize({ width: Math.round(box.width), height: Math.round(box.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
}

/** A small trend line of values, scaled to its own range. */
export function Sparkline({ values, width = 80, height = 16, className = "text-signal" }: {
  values: readonly number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) =>
    `${(index / (values.length - 1)) * width},${height - 1 - ((value - min) / span) * (height - 2)}`).join(" ");
  return (
    <svg width={width} height={height} aria-hidden className={className}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A stream's name with its device, and a button that takes it off the panel. */
export function StreamTitle({ stream, color, onRemove, children }: {
  stream: StreamInfo;
  color?: string | undefined;
  onRemove?: (() => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <span className="group/title flex min-w-0 items-center gap-1.5">
      {color && <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: color }} />}
      <span className="truncate font-mono text-2xs text-fg" title={`${stream.hardwareId}/${stream.streamId}`}>
        {streamName(stream)}
      </span>
      <span className="truncate text-2xs text-fg-3">{deviceName(stream.hardwareId)}</span>
      {children}
      {onRemove && (
        <IconButton label={`从面板移除 ${stream.streamId}`} size="icon-xs" variant="ghost"
          className="ml-auto opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100" onClick={onRemove}>
          <XIcon />
        </IconButton>
      )}
    </span>
  );
}

export function PanelEmpty({ icon, text }: { icon: ReactNode; text: string }) {
  return <EmptyState compact className="h-full" icon={icon} title={text} />;
}

/** The value a panel reads now: at the picked instant while stopped, else the newest. */
export function readingAt(follow: boolean, marker: number | undefined): number | undefined {
  return follow ? undefined : marker;
}
