import { useEffect, useState } from "react";

export const THREAD_DRAWER_STORAGE_KEY = "hardwareharness.agent-thread-drawer-open";

export function usePersistedThreadDrawer(enabled: boolean) {
  const [open, setOpen] = useState(() => localStorage.getItem(THREAD_DRAWER_STORAGE_KEY) === "true");

  useEffect(() => {
    localStorage.setItem(THREAD_DRAWER_STORAGE_KEY, String(open));
  }, [open]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "b" || !enabled) return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [enabled, open]);

  return [open, setOpen] as const;
}
