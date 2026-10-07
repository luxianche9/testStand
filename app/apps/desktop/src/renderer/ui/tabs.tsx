import * as React from "react";
import { cn } from "./cn";

/** Compact segmented control. Each option is a toggle button (`aria-pressed`) inside a labelled group. */
export function SegmentedControl<T extends string>({ label, value, options, onChange, className, size = "sm" }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: React.ReactNode; title?: string; disabled?: boolean }>;
  onChange: (value: T) => void;
  className?: string;
  size?: "xs" | "sm";
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex items-center gap-px rounded-md border border-line bg-surface-0 p-px", className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          aria-pressed={option.value === value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "inline-flex items-center gap-1 rounded-[3px] px-2 text-fg-2 transition-colors duration-120",
            "hover:text-fg disabled:opacity-45 aria-pressed:bg-surface-3 aria-pressed:text-fg",
            "[&_svg]:size-3.5",
            size === "xs" ? "h-5 text-xs" : "h-6 text-sm"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
