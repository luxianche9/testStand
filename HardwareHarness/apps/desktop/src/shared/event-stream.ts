import type { LocalApiEndpoint } from "./desktop-ipc.js";

export interface ServerSentEvent {
  id?: string;
  event: string;
  data: string;
}

/** Incremental `text/event-stream` parser: feed decoded chunks, get whole events. */
export function createSseParser(emit: (event: ServerSentEvent) => void): (chunk: string) => void {
  let buffer = "";
  let id: string | undefined;
  let event = "";
  let data: string[] = [];
  return (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        if (data.length > 0) emit({ ...(id === undefined ? {} : { id }), event: event || "message", data: data.join("\n") });
        id = undefined;
        event = "";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
  };
}

export interface EventStreamOptions {
  endpoint(): Promise<LocalApiEndpoint>;
  /** Called when the endpoint was refused, so the next attempt asks main again. */
  forgetEndpoint(): void;
  dispatch(event: string, payload: unknown): void;
  fetch?: typeof fetch;
  /** Path and query of the stream; `/api/events` by default. */
  path?: string;
  /** Resume point of the first connection; main passes `"0"` to replay what it missed at startup. */
  after?: string;
  minDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Keeps one SSE stream (`GET /api/events` unless `path` says otherwise) open and resumes it with
 * `Last-Event-ID` after a drop. Events the reconnect cannot replay (backend restarted, never saw an
 * id) surface as a `gap` so views refetch.
 */
export function startEventStream(options: EventStreamOptions): () => void {
  const request = options.fetch ?? fetch;
  const minDelay = options.minDelayMs ?? 250;
  const maxDelay = options.maxDelayMs ?? 5_000;
  const path = options.path ?? "/api/events";
  const controller = new AbortController();
  let lastId = options.after;
  let origin: string | undefined;
  let connected = false;

  const connectOnce = async (): Promise<void> => {
    const endpoint = await options.endpoint();
    const resumable = (origin === undefined || origin === `${endpoint.url}|${endpoint.token}`) && lastId !== undefined;
    if (connected && !resumable) options.dispatch("gap", { after: null });
    if (!resumable) lastId = undefined;
    origin = `${endpoint.url}|${endpoint.token}`;
    const response = await request(`${endpoint.url}${path}`, {
      headers: { authorization: `Bearer ${endpoint.token}`, accept: "text/event-stream", ...(lastId === undefined ? {} : { "last-event-id": lastId }) },
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 421) options.forgetEndpoint();
    if (!response.ok || !response.body) throw new Error(`Event stream refused: ${response.status}`);
    connected = true;
    const parse = createSseParser((event) => {
      if (event.id !== undefined) lastId = event.id;
      options.dispatch(event.event, JSON.parse(event.data));
    });
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      parse(value);
    }
  };

  void (async () => {
    let delay = minDelay;
    while (!controller.signal.aborted) {
      const started = Date.now();
      try {
        await connectOnce();
      } catch (error) {
        if (error instanceof TypeError) options.forgetEndpoint();
      }
      if (controller.signal.aborted) return;
      // A connection that lived a while starts the backoff over.
      if (Date.now() - started > maxDelay) delay = minDelay;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, maxDelay);
    }
  })();

  return () => controller.abort();
}
