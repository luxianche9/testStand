/**
 * Run observability: recorded streams, the run timeline and live probes. Every time is in
 * backend milliseconds (`tb`) unless a field says otherwise (`t` = the service's own clock).
 */

export type StreamType = "scalar" | "bits" | "bytes" | "frames" | "block" | "blob" | "events";
export type StreamDirection = "tx" | "rx" | "mark";
export type StepVerdict = "pass" | "fail" | "error" | "inconclusive" | "skipped" | "aborted";

/** Service clock mapped onto backend time; `offsetMs` is null until the first `/time` sync. */
export interface StreamClock {
  offsetMs?: number | null;
  uncertaintyMs?: number | null;
  [key: string]: unknown;
}

export interface StreamGap {
  reason: string;
  fromSeq?: number | null;
  toSeq?: number | null;
  t0?: number | null;
  t1?: number | null;
  tb?: number | null;
  tb1?: number;
}

/** One stored record: `i` orders the store, `seq` the service; the rest is the stream payload. */
export interface StreamRecord {
  i: number;
  seq?: number;
  t: number;
  tb: number;
  op?: string;
  v?: number | string | boolean | null;
  mask?: number | string;
  dir?: StreamDirection;
  data?: string;
  id?: number | string;
  t0?: number;
  dt?: number;
  samples?: number[];
  ref?: string;
  [key: string]: unknown;
}

/** A display point for a sampled stream (`scalar`, `block` expanded, `bits` changes). */
export interface StreamPoint {
  t: number;
  tb: number;
  v?: number | string | boolean | null;
  mask?: number | string;
  seq?: number;
}

export interface StreamInfo {
  key: string;
  hardwareId: string;
  streamId: string;
  type: StreamType | string;
  clock: StreamClock | null;
  count: number;
  first: { t: number; tb: number } | null;
  last: { t: number; tb: number } | null;
  lastI: number | null;
  watermark: number | null;
  watermarkTb: number | null;
  gaps: number;
  states: string[];
  /** A numeric field decoded from a protocol binding's source stream (finished runs only). */
  derived?: DerivedStreamInfo;
}

export interface DerivedStreamInfo {
  alias: string;
  icd: string;
  icdHash: string;
  /** Key of the raw stream it is decoded from. */
  source: string;
  message: string | null;
  field: string | null;
  unit?: string;
  label?: string;
}

export interface StreamReadQuery {
  /** Backend-time window; defaults to the stream's extent. */
  t0?: number;
  t1?: number;
  /** Sampled streams: return at most this many points (min/max downsampled). */
  maxPoints?: number;
  /** Records mode: the last `i` already seen. */
  after?: number;
  limit?: number;
}

interface StreamReadBase {
  key: string;
  type: StreamType | string;
  t0: number | null;
  t1: number | null;
  watermarkTb: number | null;
  clock: StreamClock | null;
  lastI: number | null;
  recording: boolean;
  gaps: StreamGap[];
}

export interface StreamPointsRead extends StreamReadBase {
  mode: "points";
  count: number;
  points: StreamPoint[];
  downsampled?: boolean;
}

export interface StreamRecordsRead extends StreamReadBase {
  mode: "records";
  records: StreamRecord[];
  /** The last `i` returned when more records are waiting, else null. */
  next: number | null;
  blobs?: Record<string, { mime: string; size: number; sha256: string }>;
}

export type StreamRead = StreamPointsRead | StreamRecordsRead;

/** A connection state change recorded for a stream (`connected`, `sampling`, `disconnected`, ...). */
export interface StreamState {
  tb: number;
  state: string;
  message?: string | null;
}

/**
 * One stream for a display whose pixel columns are `colMs` wide (design doc 5.9.3). Sampled
 * streams carry `points`: min and max of each column of the absolute grid `floor(tb / colMs)`.
 * Other streams carry `records` (`next` when more are waiting).
 */
export interface StreamWindow {
  key: string;
  type: StreamType | string;
  t0: number;
  t1: number | null;
  colMs: number;
  watermarkTb: number | null;
  lastI: number | null;
  gaps: StreamGap[];
  state: StreamState | null;
  points?: StreamPoint[];
  records?: StreamRecord[];
  next?: number | null;
  blobs?: Record<string, { mime: string; size: number; sha256: string }>;
}

/** `streams.window`: recorded streams of a run over `[t0, t1]`. */
export interface RunStreamWindow {
  runId: string;
  t0: number;
  t1: number;
  colMs: number;
  recording: boolean;
  streams: Record<string, StreamWindow>;
}

/**
 * A live stream's change in one frame. Sampled streams: `reset` replaces the client's points,
 * otherwise `points` replace those from `t0` on (`t0` is a column boundary); without `points`
 * only the watermark, gaps or state moved. Record streams: `records` are new, append them.
 */
export interface LiveStreamEntry extends StreamWindow {
  reset?: boolean;
}

/** `GET /api/live` frame, every 50 ms while something changed (the frame time `t` is its id). */
export interface LiveFrame {
  t: number;
  colMs: number;
  streams: Record<string, LiveStreamEntry>;
}

export interface LiveQuery {
  /** Stream keys `<hardwareId>__<streamId>`, at most 64. */
  keys: string[];
  /** Pixel columns of the display. */
  width: number;
  /** Sliding window the frames cover. */
  windowMs: number;
}

export interface RunStreams {
  runId: string;
  recording: boolean;
  streams: StreamInfo[];
}

export interface TimelineStep {
  executionId: string;
  stepId: string;
  stepType: string;
  region: "prepare" | "test" | "cleanup" | string;
  parentExecutionId?: string;
  tb0: number | null;
  tb1: number | null;
  verdict: StepVerdict | string | null;
  durationMs: number | null;
}

export interface TimelineCall {
  operationId: string;
  executionId: string;
  stepId: string;
  hardwareId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  tb0: number | null;
  tb1: number | null;
  state: string;
  timing?: Record<string, unknown>;
}

export interface TimelineAnchor {
  name: string;
  hardwareId: string;
  t: number | null;
  tb: number | null;
  stepId: string;
  executionId: string;
  uncertaintyMs?: number;
}

/** One judged Observe / Expect window. */
export interface TimelineWindow {
  sequence: number;
  stepId: string;
  executionId: string;
  name?: string;
  type: "observe" | "expect" | string;
  key: string;
  hardwareId: string;
  streamId: string;
  verdict: StepVerdict | string;
  reason?: string;
  message?: string;
  t0?: number | null;
  t1?: number | null;
  tb0: number | null;
  tb1: number | null;
  matchTb?: number;
  uncertaintyMs?: number;
}

export interface TimelineViolation {
  stepId: string;
  key: string;
  tb: number;
  onViolation: "fail" | "abort" | string;
  violation: Record<string, unknown>;
}

export interface TimelineMark {
  type: string;
  tb: number;
  hardwareId?: string;
  message?: string;
  region?: string;
}

export interface RunTimeline {
  runId: string;
  tb0: number | null;
  tb1: number | null;
  steps: TimelineStep[];
  calls: TimelineCall[];
  anchors: TimelineAnchor[];
  windows: TimelineWindow[];
  violations: TimelineViolation[];
  marks: TimelineMark[];
  streams: StreamInfo[];
  gaps: (StreamGap & { key: string })[];
}

export interface RunIoStream {
  key: string;
  hardwareId: string;
  streamId: string;
  type: StreamType | string;
  gaps: number;
  summary?: Record<string, number | string | null>;
  records?: StreamRecord[];
  more?: boolean;
}

/** A protocol binding of a run, with the ICD frozen in its recording. */
export interface RunProtocolBinding {
  alias: string;
  icd: string;
  icdHash: string;
  hardwareId: string;
  streamId: string;
  source: string;
  /** The source stream is in the recording. */
  recorded: boolean;
  messages: string[];
}

/** One row of the message table: a decoded frame, an undecodable one or bytes that never framed. */
export interface RunMessage {
  alias: string;
  streamId: string;
  kind: "message" | "error" | "unframed";
  t: number;
  tb?: number | null;
  seq?: number | null;
  seqFrom?: number;
  dir?: string;
  id?: number | string;
  message?: string;
  fields?: Record<string, unknown>;
  /** Hex of the frame (or of the unframed bytes). */
  raw?: string;
  checksumOk?: boolean | null;
  reason?: string;
  detail?: string;
}

export interface RunMessagesQuery {
  t0?: number;
  t1?: number;
  limit?: number;
}

/** `testing.readRunMessages`: the run's protocol traffic decoded with its frozen ICDs. */
export interface RunMessages {
  runId: string;
  bindings: RunProtocolBinding[];
  messages: RunMessage[];
  total: number;
  truncated: boolean;
}

export interface RunIo {
  runId: string;
  stepId: string | null;
  tb0: number | null;
  tb1: number | null;
  steps: TimelineStep[];
  calls: TimelineCall[];
  windows: TimelineWindow[];
  violations: TimelineViolation[];
  streams: RunIoStream[];
}

export interface RunRejudge {
  runId: string;
  results: { same: boolean; [key: string]: unknown }[];
  consistent: boolean;
}

export interface DeviceStream {
  id: string;
  type: StreamType | string;
  [key: string]: unknown;
}

/** Stream assertion verdict with its evidence (metrics, the matching record, ...). */
export interface StreamVerdict {
  verdict: StepVerdict | string;
  reason?: string;
  message?: string;
  [key: string]: unknown;
}

/** Result of a one-off `streams.observe` / `streams.expect` probe. */
export interface StreamProbe {
  hardwareId: string;
  streamId: string;
  key: string;
  window: { tb0?: number | null; tb1?: number | null; [key: string]: unknown } | null;
  clock: StreamClock;
  verdict: StreamVerdict;
  data: unknown;
}
