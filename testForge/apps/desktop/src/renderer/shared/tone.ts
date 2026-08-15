import type { BadgeTone } from "./ui.js";

export function runStatusTone(status: string): BadgeTone {
  return status === "passed"
    ? "ok"
    : status === "failed" || status === "interrupted"
      ? "bad"
      : status === "running" || status === "cancelling"
        ? "accent"
        : status === "blocked"
          ? "warn"
          : "muted";
}

export function nodeStatusTone(status: string): BadgeTone {
  return status === "passed"
    ? "ok"
    : status === "failed"
      ? "bad"
      : status === "running"
        ? "accent"
        : status === "waiting_operator"
          ? "warn"
          : "muted";
}
