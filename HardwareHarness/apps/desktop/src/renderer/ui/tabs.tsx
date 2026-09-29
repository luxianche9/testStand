import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "./cn";

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

/** Underlined tab strip used for panel headers. */
export function TabsList({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn("flex h-9 shrink-0 items-stretch gap-3 border-b border-line px-3", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "relative -mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent text-sm text-fg-2",
        "transition-colors duration-120 outline-none hover:text-fg",
        "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
        "data-[state=active]:border-signal data-[state=active]:text-fg",
        "[&_svg]:size-3.5",
        className
      )}
      {...props}
    />
  );
}

/**
 * Panel header whose title is a tab strip: click a title to switch what the panel shows.
 * Pair each option with an element carrying `id={`${idPrefix}-${value}`}` and role="tabpanel".
 */
export function HeaderTabs<T extends string>({ label, idPrefix, value, options, onChange, actions, className }: {
  label: string;
  idPrefix: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: React.ReactNode; meta?: React.ReactNode }>;
  onChange: (value: T) => void;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex h-9 shrink-0 items-stretch gap-3 border-b border-line px-3", className)}>
      <div role="tablist" aria-label={label} className="flex min-w-0 items-stretch gap-3">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${idPrefix}-${option.value}`}
              onClick={() => onChange(option.value)}
              className={cn(
                "relative -mb-px inline-flex items-center gap-1.5 border-b-2 text-sm whitespace-nowrap",
                "transition-colors duration-120 outline-none hover:text-fg",
                "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
                selected ? "border-signal text-fg" : "border-transparent text-fg-2"
              )}
            >
              {option.label}
              {option.meta !== undefined && <span className="tf-num text-xs text-fg-3">{option.meta}</span>}
            </button>
          );
        })}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

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
