import { describe, expect, it } from "vitest";
import { mergeFile, updateTab, workspacePreferences, type EditorTab } from "./workspace-model.js";

const original: EditorTab = { path: "scripts/main.py", content: "old", savedContent: "old", hash: "one" };

describe("application editor documents", () => {
  it("refreshes clean tabs and preserves unsaved work when an external edit arrives", () => {
    expect(mergeFile(original, { path: original.path, content: "remote", hash: "two" }).content).toBe("remote");
    const dirty = updateTab(original, "local");
    const conflict = mergeFile(dirty, { path: original.path, content: "remote", hash: "two" });
    expect(conflict.content).toBe("local");
    expect(conflict.savedContent).toBe("old");
    expect(conflict.conflict?.content).toBe("remote");
  });
  it("does not report a conflict for unchanged disk bytes", () => {
    expect(mergeFile(updateTab(original, "local"), { path: original.path, content: "old", hash: "one" }).conflict).toBeUndefined();
  });
  it("clears a conflict after the local and disk versions have been merged", () => {
    const disk = { path: original.path, content: "merged", hash: "two" };
    const conflict = mergeFile(updateTab(original, "local"), disk);
    expect(mergeFile(updateTab(conflict, "merged"), disk)).toEqual({ ...disk, savedContent: "merged" });
  });
  it("restores only bounded persisted layout and document paths", () => {
    expect(workspacePreferences('{"width":9999,"tabs":["scripts/a.py","apps/a.py",3],"activePath":"scripts/a.py"}')).toMatchObject({ width: 440, tabs: ["scripts/a.py"], activePath: "scripts/a.py" });
    expect(workspacePreferences("broken")).toEqual({ width: 220, tabs: [] });
  });
});
