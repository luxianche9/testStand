import { useEffect, useState } from "react";
import type { StreamLatest } from "@teststand/contracts/observability";

export type LatestEntry = StreamLatest["streams"][string];

/** The backend reads at most this many keys per call. */
const MAX_KEYS = 64;

/**
 * The newest record of each stream, polled every `intervalMs` while `active`. Each poll also keeps the
 * backend following the streams, so the values stay live; a failed poll keeps the last values.
 */
export function useLatestValues(keys: readonly string[], active: boolean, intervalMs = 500):
  ReadonlyMap<string, LatestEntry> {
  const [values, setValues] = useState<ReadonlyMap<string, LatestEntry>>(new Map());
  const joined = keys.join("\n");
  useEffect(() => {
    const wanted = joined ? joined.split("\n") : [];
    if (!active || !wanted.length) return undefined;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      const chunks: string[][] = [];
      for (let start = 0; start < wanted.length; start += MAX_KEYS) chunks.push(wanted.slice(start, start + MAX_KEYS));
      const results = await Promise.allSettled(chunks.map((chunk) => window.teststand.streams.latest({ keys: chunk })));
      if (stopped) return;
      setValues((current) => {
        const next = new Map(current);
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          for (const [key, entry] of Object.entries(result.value.streams)) next.set(key, entry);
        }
        return next;
      });
      timer = window.setTimeout(() => void poll(), intervalMs);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [joined, active, intervalMs]);
  return values;
}
