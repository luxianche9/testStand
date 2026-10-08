import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { StreamRef } from "@teststand/contracts/monitor";
import type { DeviceStream, RunTimeline, StreamDeclaration, StreamInfo } from "@teststand/contracts/observability";
import type { ProjectDocument } from "@teststand/contracts/projects";
import { useMonitorStreams, useProjectDocument } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";

/** Drag payload of a device stream in the devices panel: `{hardwareId, streamId}` as JSON. */
export const STREAM_MIME = "application/x-teststand-stream";

const EMPTY: StreamRef[] = [];

export function streamKey(ref: StreamRef): string {
  return `${ref.hardwareId}__${ref.streamId}`;
}

export function readDraggedStream(data: DataTransfer): StreamRef | undefined {
  try {
    const value = JSON.parse(data.getData(STREAM_MIME)) as Partial<StreamRef>;
    return typeof value.hardwareId === "string" && typeof value.streamId === "string"
      ? { hardwareId: value.hardwareId, streamId: value.streamId }
      : undefined;
  } catch {
    return undefined;
  }
}

/** What the scope and the terminal need of a stream the device declares; live frames carry the rest. */
export function declaredStreamInfo(hardwareId: string, stream: DeviceStream | undefined, streamId: string): StreamInfo {
  const declaration = (stream ?? {}) as StreamDeclaration & { rateHz?: number };
  return {
    key: `${hardwareId}__${streamId}`,
    hardwareId,
    streamId,
    type: stream?.type ?? "scalar",
    clock: null,
    count: 0,
    first: null,
    last: null,
    lastI: null,
    watermark: null,
    watermarkTb: null,
    gaps: 0,
    // A sampled stream is drawn as a trace; one published on write holds its level.
    states: declaration.rateHz ? ["sampling"] : [],
    declaration
  };
}

/**
 * The monitor panel's channels as the project stores them, the streams of every device, and the
 * edits the panel makes (drop a stream on it, remove one). Edits go to the project buffer.
 */
export function useMonitorChannels(timeline: RunTimeline | undefined) {
  const client = useQueryClient();
  const project = useProjectDocument();
  const devices = useMonitorStreams();
  const channels = project.data?.file.monitor.channels ?? EMPTY;
  const update = useMutation({
    mutationFn: (next: StreamRef[]) => window.teststand.monitor.update({ input: { channels: next } }),
    onMutate: (next) => {
      client.setQueryData<ProjectDocument | null>(queryKeys.projectDocument, (current) => current
        ? { ...current, dirty: true, file: { ...current.file, monitor: { channels: next } } }
        : current);
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.projectDocument })
  });
  const save = update.mutate;
  const add = useCallback((ref: StreamRef) => {
    if (!channels.some((item) => streamKey(item) === streamKey(ref))) save([...channels, ref]);
  }, [channels, save]);
  const remove = useCallback((ref: StreamRef) => {
    save(channels.filter((item) => streamKey(item) !== streamKey(ref)));
  }, [channels, save]);

  const streams = useMemo<StreamInfo[]>(() => {
    const declared = new Map<string, DeviceStream>((devices.data ?? []).flatMap((device) =>
      device.streams.map((stream): [string, DeviceStream] => [`${device.hardwareId}__${stream.id}`, stream])));
    const recorded = new Map((timeline?.streams ?? []).map((stream) => [stream.key, stream]));
    return channels.map((ref) => {
      const key = streamKey(ref);
      const info = declaredStreamInfo(ref.hardwareId, declared.get(key), ref.streamId);
      const run = recorded.get(key);
      if (!run) return info;
      const merged: StreamInfo = { ...info, ...run };
      if (!run.declaration && info.declaration) merged.declaration = info.declaration;
      return merged;
    });
  }, [channels, devices.data, timeline?.streams]);
  return { channels, streams, add, remove, error: update.error };
}
