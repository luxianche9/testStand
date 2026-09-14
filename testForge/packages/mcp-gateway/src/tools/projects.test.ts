import { describe, expect, it, vi } from "vitest";
import type { TestForgeApplication } from "@testforge/application";
import { AGENT_REQUEST_CONTEXT } from "@testforge/application";
import { resolve } from "node:path";
import { PROJECT_TOOLS } from "./projects.js";

function setup(dirty = false, state = "idle") {
  const projects = {
    document: vi.fn(() => ({ dirty })), initializeFolder: vi.fn(async () => ({ dirty: false })),
    openFolder: vi.fn(async () => ({ dirty: false })), saveProject: vi.fn(async () => ({ dirty: false }))
  };
  const application = { projects, system: { dashboard: () => ({ execution: { state } }) } } as unknown as TestForgeApplication;
  const invoke = async (name: string, input: unknown) => {
    const tool = PROJECT_TOOLS.find((t) => t.tool.name === name)!;
    return await tool.execute(application, AGENT_REQUEST_CONTEXT, tool.parse(input));
  };
  return { projects, invoke };
}

describe("project MCP tools", () => {
  it("uses existing project services with the agent context", async () => {
    const { projects, invoke } = setup();
    const rootPath = resolve("example");
    await invoke("initialize_project", { rootPath });
    expect(projects.initializeFolder).toHaveBeenCalledWith(AGENT_REQUEST_CONTEXT, rootPath);
    await invoke("open_project", { rootPath });
    expect(projects.openFolder).toHaveBeenCalledWith(AGENT_REQUEST_CONTEXT, rootPath);
    await invoke("save_project", {});
    expect(projects.saveProject).toHaveBeenCalledWith(AGENT_REQUEST_CONTEXT);
  });
  it.each(["initialize_project", "open_project"])("%s preserves unsaved work", async (name) => {
    const { projects, invoke } = setup(true);
    await expect(invoke(name, { rootPath: resolve("example") })).rejects.toThrow("Save the current project");
    expect(projects.initializeFolder).not.toHaveBeenCalled();
    expect(projects.openFolder).not.toHaveBeenCalled();
  });
  it("does not interrupt active execution to switch projects", async () => {
    const { projects, invoke } = setup(false, "run");
    await expect(invoke("open_project", { rootPath: resolve("example") })).rejects.toThrow("Finish the active execution");
    expect(projects.openFolder).not.toHaveBeenCalled();
  });
  it("rejects relative project paths and extra parameters", async () => {
    const { invoke } = setup();
    await expect(invoke("initialize_project", { rootPath: "relative" })).rejects.toThrow();
    await expect(invoke("save_project", { force: true })).rejects.toThrow();
  });
});
