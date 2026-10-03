import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface WindowState { width: number; height: number; maximized: boolean }

export function readWindowState(path?: string): WindowState {
  const fallback = { width: 1360, height: 860, maximized: false };
  if (!path) return fallback;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WindowState> | null;
    return {
      width: boundedSize(value?.width, 1040, fallback.width),
      height: boundedSize(value?.height, 680, fallback.height),
      maximized: value?.maximized === true
    };
  } catch { return fallback; }
}

export function writeWindowState(path: string, state: WindowState): void {
  const temporary = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify(state), "utf8");
    renameSync(temporary, path);
  } catch {
    // Preferences must not prevent the window from resizing or closing.
    try { rmSync(temporary, { force: true }); } catch { /* Best effort cleanup. */ }
  }
}

function boundedSize(value: unknown, minimum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(10000, Math.max(minimum, Math.round(value)))
    : fallback;
}
