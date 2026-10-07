import { useEffect, useState } from "react";
import type { ThemeChoice } from "@teststand/contracts/storage";

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => { void window.teststand.settings.get().then((settings) => setChoice(settings.theme)); }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setSystemDark(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  const resolved: "light" | "dark" = choice === "dark" || (choice === "system" && systemDark) ? "dark" : "light";
  useEffect(() => { document.documentElement.dataset.theme = resolved; }, [resolved]);

  const select = async (next: ThemeChoice) => {
    setChoice(next);
    await window.teststand.settings.update({ theme: next });
    await window.teststand.window.applyTheme(next);
  };
  return { choice, resolved, select };
}
