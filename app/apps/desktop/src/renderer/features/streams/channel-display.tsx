import type { StreamInfo } from "@teststand/contracts/observability";

/** How a bits channel is drawn on the time axis: a lane per bit, or one lane of value segments. */
type TraceMode = "logic" | "bus";
/** How a bits channel shows its state at the cursor. */
type StateMode = "lamps" | "switches" | "code";

export interface ChannelDisplay {
  trace: TraceMode;
  state: StateMode;
}

/**
 * What the plugin suggests (`display` in its stream declaration): relay contacts as switches,
 * a control / status word as a code, independent lines as lamps. Without a hint, named lines
 * read as lamps and an unnamed mask as a code.
 */
export function defaultDisplay(stream: Pick<StreamInfo, "declaration">): ChannelDisplay {
  const declared = stream.declaration?.display;
  if (declared === "switches") return { trace: "logic", state: "switches" };
  if (declared === "code") return { trace: "bus", state: "code" };
  if (declared === "lamps" || stream.declaration?.bitLabels?.length) return { trace: "logic", state: "lamps" };
  return { trace: "bus", state: "code" };
}
