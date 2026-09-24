import type { CSSProperties } from "react";
import type { ThemeChoice } from "@hardwareharness/contracts/storage";
import { CheckIcon } from "lucide-react";
import { cn } from "../../ui";
import { SettingsCard, SettingsHeader } from "./SettingsLayout.js";

const choices: Array<{ value: ThemeChoice; title: string; body: string }> = [
  { value: "system", title: "跟随系统", body: "随操作系统自动切换浅色或深色。" },
  { value: "light", title: "浅色", body: "始终使用浅色界面。" },
  { value: "dark", title: "深色", body: "始终使用深色界面。" }
];

/*
 * The previews must show the *other* theme too, so they re-declare that theme's surface tokens on a
 * wrapper (mirroring styles/tokens.css) and draw with the normal semantic classes underneath.
 */
const palettes = {
  dark: {
    "--tf-surface-0": "oklch(0.155 0.006 250)",
    "--tf-surface-1": "oklch(0.185 0.006 250)",
    "--tf-surface-2": "oklch(0.225 0.007 250)",
    "--tf-line": "oklch(1 0 0 / 8%)",
    "--tf-fg-3": "oklch(0.54 0.01 250)",
    "--tf-signal": "oklch(0.8 0.15 75)",
    "--tf-pass": "oklch(0.77 0.16 152)"
  },
  light: {
    "--tf-surface-0": "oklch(0.972 0.003 90)",
    "--tf-surface-1": "oklch(0.995 0.001 90)",
    "--tf-surface-2": "oklch(0.952 0.004 90)",
    "--tf-line": "oklch(0.2 0.01 250 / 10%)",
    "--tf-fg-3": "oklch(0.57 0.012 250)",
    "--tf-signal": "oklch(0.62 0.15 60)",
    "--tf-pass": "oklch(0.55 0.15 150)"
  }
} as const;

export function AppearanceSettings({ value, onChange }: {
  value: ThemeChoice;
  onChange: (theme: ThemeChoice) => Promise<void>;
}) {
  return (
    <>
      <SettingsHeader title="外观" description="选择 HardwareHarness 的界面主题。深色为默认的测控台配色，浅色适合明亮环境。" />
      <SettingsCard title="界面主题" meta={choices.find((choice) => choice.value === value)?.title}>
        <div className="grid grid-cols-3 gap-3 p-3">
          {choices.map((choice) => {
            const active = value === choice.value;
            return (
              <button
                key={choice.value}
                type="button"
                aria-pressed={active}
                onClick={() => void onChange(choice.value)}
                className={cn(
                  "group grid gap-2 rounded-md border border-line bg-surface-0 p-2 text-left outline-none",
                  "transition-colors duration-120 hover:border-line-strong",
                  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal",
                  active && "border-signal hover:border-signal"
                )}
              >
                <ThemePreview choice={choice.value} />
                <span className="flex items-center gap-1.5 px-0.5 text-sm font-medium text-fg">
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-3.5 place-items-center rounded-full border border-line-strong",
                      active && "border-signal bg-signal text-signal-fg"
                    )}
                  >
                    {active && <CheckIcon className="size-2.5" strokeWidth={3} />}
                  </span>
                  {choice.title}
                </span>{" "}
                <span className="px-0.5 text-xs leading-4 text-fg-3">{choice.body}</span>
              </button>
            );
          })}
        </div>
      </SettingsCard>
    </>
  );
}

function ThemePreview({ choice }: { choice: ThemeChoice }) {
  if (choice !== "system") return <MiniConsole palette={choice} />;
  return (
    <span aria-hidden className="relative block">
      <MiniConsole palette="light" />
      <span className="absolute inset-0 [clip-path:polygon(55%_0,100%_0,100%_100%,45%_100%)]">
        <MiniConsole palette="dark" />
      </span>
    </span>
  );
}

/** A tiny drawing of the app: title bar, rail, canvas, a lamp and an accent control. */
function MiniConsole({ palette }: { palette: keyof typeof palettes }) {
  return (
    <span
      aria-hidden
      style={palettes[palette] as CSSProperties}
      className="grid h-[72px] grid-cols-[26%_1fr] grid-rows-[12px_1fr] overflow-hidden rounded-sm border border-line"
    >
      <span className="col-span-2 flex items-center gap-1 border-b border-line bg-surface-1 px-1.5">
        <span className="size-1 rounded-full bg-signal" />
        <span className="h-0.5 w-6 rounded-full bg-fg-3/50" />
      </span>
      <span className="grid content-start gap-1 border-r border-line bg-surface-1 p-1.5">
        <span className="h-0.5 w-full rounded-full bg-fg-3/60" />
        <span className="h-0.5 w-3/4 rounded-full bg-fg-3/40" />
        <span className="h-0.5 w-5/6 rounded-full bg-fg-3/40" />
      </span>
      <span className="relative bg-surface-0">
        <span className="absolute top-2 left-2 h-4 w-8 rounded-[2px] border border-line bg-surface-2" />
        <span className="absolute top-3.5 left-12 size-1 rounded-full bg-pass" />
        <span className="absolute right-2 bottom-2 h-2 w-7 rounded-[2px] bg-signal" />
      </span>
    </span>
  );
}
