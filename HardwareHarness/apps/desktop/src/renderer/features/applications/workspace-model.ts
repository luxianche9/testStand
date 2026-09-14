import type { WorkspaceFile } from "@hardwareharness/contracts/applications";

export interface EditorTab extends WorkspaceFile {
  savedContent: string;
  conflict?: WorkspaceFile;
  readOnly?: boolean;
}

export function updateTab(tab: EditorTab, content: string): EditorTab { return { ...tab, content }; }

export function mergeFile(tab: EditorTab, file: WorkspaceFile): EditorTab {
  if (tab.hash === file.hash) return tab;
  if (tab.content !== tab.savedContent) return { ...tab, conflict: file };
  return { ...file, savedContent: file.content };
}

export function workspacePreferences(raw: string | null): { width: number; tabs: string[]; appId?: string; activePath?: string; drafts?: EditorTab[] } {
  try {
    const value = JSON.parse(raw ?? "{}");
    return {
      width: typeof value.width === "number" && Number.isFinite(value.width) ? Math.max(160, Math.min(440, value.width)) : 220,
      tabs: Array.isArray(value.tabs) ? value.tabs.filter((path: unknown): path is string => typeof path === "string") : [],
      ...(typeof value.appId === "string" ? { appId: value.appId } : {}),
      ...(typeof value.activePath === "string" ? { activePath: value.activePath } : {}),
      ...(Array.isArray(value.drafts) ? { drafts: value.drafts.filter((item: unknown): item is EditorTab => {
        if (!item || typeof item !== "object") return false;
        const draft = item as Record<string, unknown>;
        return [draft.path, draft.content, draft.savedContent, draft.hash].every((field) => typeof field === "string");
      }) } : {})
    };
  } catch { return { width: 220, tabs: [] }; }
}
