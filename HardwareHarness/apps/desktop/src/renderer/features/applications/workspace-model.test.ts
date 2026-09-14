import { describe, expect, it } from "vitest";
import { mergeFile, updateTab, workspacePreferences, type EditorTab } from "./workspace-model.js";

const original: EditorTab = { path: "workflows/main.py", content: "old", savedContent: "old", hash: "one" };

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
  it("restores only bounded persisted layout and document paths", () => {
    expect(workspacePreferences('{"width":9999,"tabs":["workflows/a.py",3],"appId":"demo"}')).toMatchObject({ width: 440, tabs: ["workflows/a.py"], appId: "demo" });
    expect(workspacePreferences("broken")).toEqual({ width: 220, tabs: [] });
  });
});
