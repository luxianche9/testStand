import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

export const themeLabels: Record<ThemeChoice, string> = { system: "跟随系统", light: "浅色", dark: "深色" };

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => { void window.testforge.settings.getTheme().then(setChoice); }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setSystemDark(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  const resolved = choice === "dark" || (choice === "system" && systemDark) ? "dark" : "light";
  useEffect(() => { document.documentElement.dataset.theme = resolved; }, [resolved]);

  const select = async (next: ThemeChoice) => {
    setChoice(next);
    await window.testforge.settings.setTheme(next);
  };
  const cycle = async () => {
    const next: ThemeChoice = choice === "system" ? "light" : choice === "light" ? "dark" : "system";
    await select(next);
  };
  return { choice, resolved, select, cycle };
}
