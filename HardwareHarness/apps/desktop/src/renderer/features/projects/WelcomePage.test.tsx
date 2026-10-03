// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HardwareHarnessApi } from "@hardwareharness/contracts/desktop";
import type { ProjectFolderSelection, RecentProjectSummary } from "@hardwareharness/contracts/projects";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WelcomePage } from "./WelcomePage";

vi.mock("../wiring/TopologyPreview.js", () => ({
  TopologyPreview: ({ project }: { project: RecentProjectSummary }) => (
    <div role="img" aria-label={`${project.name} 工位接线缩略图`} />
  )
}));

const project = (name: string, status: RecentProjectSummary["status"] = "available"): RecentProjectSummary => ({
  rootPath: `C:\\work\\${name}`,
  name,
  openedAt: "2026-09-01T08:00:00.000Z",
  status,
  preview: { nodes: [], connections: [] }
});

function setup({ recent = [project("project-a"), project("project-b", "missing")], chosen }: {
  recent?: RecentProjectSummary[];
  chosen?: ProjectFolderSelection | null;
} = {}) {
  const api = {
    dialogs: { chooseProjectFolder: vi.fn(async () => chosen?.rootPath ?? null) },
    projects: {
      listRecent: vi.fn(async () => recent),
      inspectFolder: vi.fn(async () => chosen ?? null),
      openFolder: vi.fn(async ({ rootPath }: { rootPath: string }) => ({ rootPath })),
      initializeFolder: vi.fn(async ({ rootPath }: { rootPath: string }) => ({ rootPath })),
      forgetRecent: vi.fn(async () => undefined)
    },
    devices: { listHardware: vi.fn(async () => []) },
    settings: { get: vi.fn(async () => ({ welcomeLayout: "grid" })), update: vi.fn(async () => undefined) }
  };
  Object.defineProperty(window, "hardwareharness", {
    configurable: true,
    value: api as unknown as HardwareHarnessApi
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onOpened = vi.fn();
  render(<QueryClientProvider client={client}><WelcomePage onOpened={onOpened} /></QueryClientProvider>);
  return { api, onOpened };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("WelcomePage", () => {
  it("lists recent projects and opens one by its name", async () => {
    const { api, onOpened } = setup();
    expect(screen.getByRole("heading", { name: "最近项目" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /打开项目文件夹/ })).toHaveLength(1);
    await userEvent.click(await screen.findByText("project-a", { exact: true }));
    await waitFor(() => expect(api.projects.openFolder).toHaveBeenCalledWith({ rootPath: "C:\\work\\project-a" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith("C:\\work\\project-a"));
    expect(screen.getByRole("img", { name: "project-a 工位接线缩略图" })).toBeTruthy();
    expect(screen.getByText("项目文件夹不存在")).toBeTruthy();
  });

  it("persists the layout choice and forgets a project from its menu", async () => {
    const { api } = setup();
    await screen.findByText("project-a", { exact: true });
    const layout = screen.getByRole("group", { name: "最近项目布局" });
    await userEvent.click(within(layout).getByRole("button", { name: "列表布局" }));
    expect(api.settings.update).toHaveBeenCalledWith({ welcomeLayout: "list" });
    expect(within(layout).getByRole("button", { name: "列表布局" }).getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(screen.getByRole("button", { name: "更多操作：project-a" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "从最近项目移除" }));
    await waitFor(() => expect(api.projects.forgetRecent).toHaveBeenCalledWith({ rootPath: "C:\\work\\project-a" }));
  });

  it("initializes an uninitialized folder through the shared dialog", async () => {
    const selection = { state: "uninitialized", rootPath: "C:\\new", name: "new" } as ProjectFolderSelection;
    const { api, onOpened } = setup({ recent: [], chosen: selection });
    expect(await screen.findByText("还没有项目")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "打开项目文件夹" }));
    const dialog = await screen.findByRole("dialog", { name: "初始化 HardwareHarness 项目" });
    await userEvent.click(within(dialog).getByRole("button", { name: "创建并打开" }));
    await waitFor(() => expect(api.projects.initializeFolder).toHaveBeenCalledWith({ rootPath: "C:\\new" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith("C:\\new"));
    expect(api.projects.openFolder).not.toHaveBeenCalled();
  });

  it("reports an invalid folder without opening it", async () => {
    const selection = { state: "invalid", rootPath: "C:\\bad", name: "bad", message: "清单损坏" } as ProjectFolderSelection;
    const { api } = setup({ recent: [], chosen: selection });
    await userEvent.click(screen.getByRole("button", { name: "打开项目文件夹" }));
    expect((await screen.findByRole("alert")).textContent).toContain("清单损坏");
    expect(api.projects.openFolder).not.toHaveBeenCalled();
  });
});
