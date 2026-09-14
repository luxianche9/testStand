import type { RunStatus } from "@hardwareharness/contracts/applications";
import type { BadgeTone } from "./tone.types.js";

export function runStatusTone(status: RunStatus): BadgeTone {
  return status === "succeeded" ? "ok"
    : status === "failed" || status === "interrupted" ? "bad"
      : status === "running" || status === "cancelling" ? "accent" : "muted";
}
