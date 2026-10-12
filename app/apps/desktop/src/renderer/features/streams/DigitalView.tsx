import { useMemo } from "react";
import { ToggleLeftIcon } from "lucide-react";
import type { StreamInfo } from "@teststand/contracts/observability";
import { EmptyState } from "../../ui";
import { DigitalPanel, type PanelChannel } from "./DigitalPanel.js";
import { CHANNEL_COLORS, type TimeRange } from "./stream-model.js";
import { useStreamsPoints, type StreamSource } from "./useStreamReader.js";

/**
 * A panel of its own for bits streams — DI/DO lamps, relay contacts — read at the picked instant,
 * or the newest while nothing is picked. Reads the same window as the scopes, so a run replayed
 * shows each line's state at the cursor.
 */
export function DigitalView({ streams, source, follow, spanMs, from, range, marker, emptyText }: {
  streams: StreamInfo[];
  source: StreamSource;
  follow: boolean;
  spanMs: number;
  from?: number | undefined;
  range: TimeRange | undefined;
  marker: number | undefined;
  emptyText: string;
}) {
  const channels = useMemo<PanelChannel[]>(() => streams.map((stream, index) => ({
    stream, color: CHANNEL_COLORS[index % CHANNEL_COLORS.length] ?? ""
  })), [streams]);
  const points = useStreamsPoints(source, channels.map((channel) => channel.stream.key), {
    follow, spanMs, from, range
  });
  if (!channels.length) {
    return <EmptyState className="h-full" icon={<ToggleLeftIcon />} title={emptyText} />;
  }
  return (
    <div className="h-full overflow-y-auto">
      <DigitalPanel channels={channels} reads={points.reads} at={follow ? undefined : marker} />
    </div>
  );
}
