import type { TestStandLiveApi } from "@teststand/contracts/desktop";
import type { LiveFrame, LiveQuery } from "@teststand/contracts/observability";

type Live = TestStandLiveApi["live"];

interface Consumer {
  query: LiveQuery;
  onFrame: (frame: LiveFrame) => void;
  onGap: (() => void) | undefined;
  /** Joined since the upstream subscription started: it gets that subscription's backlog first. */
  fresh: boolean;
}

/** The backend serves at most this many keys per live subscription. */
const MAX_LIVE_KEYS = 64;
const RESTART_MS = 30;

/**
 * Shares one live subscription between every widget of a canvas. The renderer reaches the backend
 * over HTTP/1.1, where a page holds only a few connections at a time, so one subscription per
 * widget would stall. The hub subscribes to the union of the wanted keys (the widest window and
 * column count asked for) and hands each consumer the part of every frame it asked for.
 *
 * A consumer that joins needs the backlog of its window, which only a new subscription sends: the
 * hub then restarts the upstream subscription and tells the existing consumers to drop their
 * buffers (`onGap`), so nobody sees a record twice.
 */
export function createLiveHub(upstream: Live): Live & { close: () => void } {
  const consumers = new Set<Consumer>();
  let stop: (() => void) | undefined;
  let timer: number | undefined;

  const restart = () => {
    timer = undefined;
    stop?.();
    stop = undefined;
    if (!consumers.size) return;
    const keys = [...new Set([...consumers].flatMap((item) => item.query.keys))].slice(0, MAX_LIVE_KEYS);
    const width = Math.max(...[...consumers].map((item) => item.query.width));
    const windowMs = Math.max(...[...consumers].map((item) => item.query.windowMs));
    for (const consumer of consumers) {
      if (!consumer.fresh) consumer.onGap?.();
      consumer.fresh = false;
    }
    stop = upstream({ keys, width, windowMs }, (frame) => {
      for (const consumer of consumers) {
        const streams = Object.fromEntries(Object.entries(frame.streams)
          .filter(([key]) => consumer.query.keys.includes(key)));
        if (Object.keys(streams).length) consumer.onFrame({ ...frame, streams });
      }
    }, () => { for (const consumer of consumers) consumer.onGap?.(); });
  };
  const schedule = () => {
    if (timer === undefined) timer = window.setTimeout(restart, RESTART_MS);
  };

  const live: Live = (query, onFrame, onGap) => {
    const consumer: Consumer = { query, onFrame, onGap, fresh: true };
    consumers.add(consumer);
    schedule();
    return () => {
      consumers.delete(consumer);
      // Extra keys cost little; only stop when nobody is left.
      if (!consumers.size) schedule();
    };
  };
  return Object.assign(live, {
    close: () => {
      consumers.clear();
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      stop?.();
      stop = undefined;
    }
  });
}
