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
  neutral: "bg-surface-2 text-fg-2",
  signal: "bg-signal/14 text-signal",
  run: "bg-run/14 text-run",
  pass: "bg-pass/14 text-pass",
  fail: "bg-fail/14 text-fail",
  invalid: "bg-invalid/14 text-invalid"
};
