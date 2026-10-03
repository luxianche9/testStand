import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ActivityIcon, SquareIcon } from "lucide-react";
import type { DeviceStream, StreamInfo } from "@hardwareharness/contracts/observability";
import { errorMessage } from "../../../lib/errors.js";
import { queryKeys } from "../../../lib/query-keys.js";
import { Button, Section } from "../../../ui";
import { StreamBoard, type StreamSource } from "../../streams/index.js";

/** Live frames only: a device watch has no recording to read ranges from. */
const LIVE_SOURCE: StreamSource = {
  live: (query, onFrame, onGap) => window.hardwareharness.streams.live(query, onFrame, onGap)
};

/**
 * 实时数据: subscribes to the device's streams (read-only, `GET /api/live`) and shows them as scope
 * traces and a TX/RX terminal. The subscription ends when stopped, when the device changes and when
 * the inspector closes. `running` means the device is connected.
 */
export function LiveStreams({ hardwareId, running }: { hardwareId: string; running: boolean }) {
  const streams = useQuery({
    queryKey: queryKeys.deviceStreams(hardwareId),
    queryFn: () => window.hardwareharness.streams.listStreams({ hardwareId }),
    enabled: running
  });
  const [watching, setWatching] = useState(false);
  useEffect(() => { setWatching(false); }, [hardwareId]);
  useEffect(() => { if (!running) setWatching(false); }, [running]);

  const available = useMemo(() => streams.data ?? [], [streams.data]);
  const infos = useMemo(() => available.map((stream) => streamInfo(hardwareId, stream)), [available, hardwareId]);
  if (!running || (!streams.isLoading && !streams.error && !available.length)) return null;
  return (
    <Section
      title="实时数据"
      actions={watching ? (
        <Button size="xs" variant="outline" onClick={() => setWatching(false)}><SquareIcon />停止</Button>
      ) : (
        <Button size="xs" variant="outline" disabled={!available.length} onClick={() => setWatching(true)}>
          <ActivityIcon />开始监视
        </Button>
      )}
    >
      {streams.error && <p className="text-xs text-fail">读取数据流失败：{errorMessage(streams.error)}</p>}
      {watching ? (
        <div className="h-90 overflow-hidden rounded-md border border-line bg-surface-0">
          <StreamBoard streams={infos} source={LIVE_SOURCE} live syncKey={`live:${hardwareId}`} />
        </div>
      ) : available.length > 0 && (
        <p className="text-xs text-fg-3">
          {available.map((stream) => `${stream.id} · ${stream.type}`).join("，")}。监视只读取数据，不控制设备。
        </p>
      )}
    </Section>
  );
}

/** What the board needs of a stream the service lists; the live frames carry the rest. */
function streamInfo(hardwareId: string, stream: DeviceStream): StreamInfo {
  return {
    key: `${hardwareId}__${stream.id}`,
    hardwareId,
    streamId: stream.id,
    type: stream.type,
    clock: null,
    count: 0,
    first: null,
    last: null,
    lastI: null,
    watermark: null,
    watermarkTb: null,
    gaps: 0,
    states: []
  };
}
