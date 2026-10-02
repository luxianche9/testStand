import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

const merge = twMerge;

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}

/** Semantic status colors shared by lamps, badges, readings and canvas edges. */
export type Tone = "neutral" | "signal" | "run" | "pass" | "fail" | "invalid";

export const toneText: Record<Tone, string> = {
  neutral: "text-fg-3",
  signal: "text-signal",
  run: "text-run",
  pass: "text-pass",
  fail: "text-fail",
  invalid: "text-invalid"
};

export const toneSurface: Record<Tone, string> = {
  neutral: "border-line-strong bg-surface-2 text-fg-2",
  signal: "border-signal/35 bg-signal/10 text-signal",
  run: "border-run/35 bg-run/10 text-run",
  pass: "border-pass/35 bg-pass/10 text-pass",
  fail: "border-fail/40 bg-fail/10 text-fail",
  invalid: "border-invalid/40 bg-invalid/10 text-invalid"
};
