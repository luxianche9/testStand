// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationsPage } from "./ApplicationsPage.js";

vi.mock("../../shared/CodeEditor.js", () => ({ CodeEditor: ({ value, path, onChange }: { value: string; path: string; onChange: (content: string) => void }) => <textarea aria-label={`编辑 ${path}`} value={value} onChange={(event) => onChange(event.target.value)} /> }));

const readFile = vi.fn();
const writeFile = vi.fn();
const createFile = vi.fn();
const startRun = vi.fn();
const api = {
  listFiles: vi.fn(async () => [{ path: "workflows/main.py", name: "main.py", kind: "file" }]),
  readFile, writeFile, createFile, startRun,
  listApps: vi.fn(async () => [{ id: "demo", name: "Demo", status: "running", previewUrl: "http://127.0.0.1:23456/?ticket=test", actions: [] }]),
  listRuns: vi.fn(async () => []), appLogs: vi.fn(async () => []), diagnostics: vi.fn(async () => []),
  initializeWorkspace: vi.fn(async () => ({})), search: vi.fn(async () => [])
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><ApplicationsPage /></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  readFile.mockResolvedValue({ path: "workflows/main.py", content: "original", hash: "before" });
  writeFile.mockImplementation(async (input: { path: string; content: string }) => ({ ...input, hash: "after" }));
  createFile.mockResolvedValue(undefined);
  api.initializeWorkspace.mockResolvedValue({ status: "ready", pythonPath: "project/.venv/python", error: null });
  Object.defineProperty(window, "hardwareharness", { configurable: true, value: {
    applications: api, projects: { current: vi.fn(async () => ({ rootPath: "test-project", file: { projectId: "P" } })) }, events: { subscribe: vi.fn(() => () => undefined) }
  } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Python application workspace", () => {
  it("prepares the default environment without enabling network access", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("button", { name: "准备 Python 环境" }));
    await waitFor(() => expect(api.initializeWorkspace).toHaveBeenCalledWith());
    expect(await screen.findByText(/Python 环境已准备完成/)).toBeTruthy();
  });
  it("installs dependencies online only through the explicit action and displays failures", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("button", { name: "联网安装依赖" }));
    await waitFor(() => expect(api.initializeWorkspace).toHaveBeenCalledWith({ online: true }));
    expect(await screen.findByText(/联网安装依赖已完成/)).toBeTruthy();
    api.initializeWorkspace.mockRejectedValueOnce(new Error("No matching distribution found"));
    await user.click(screen.getByRole("button", { name: "联网安装依赖" }));
    expect(await screen.findByText("No matching distribution found")).toBeTruthy();
  });
  it("does not install dependencies while any editor has unsaved changes", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("treeitem", { name: "main.py" }));
    await user.type(await screen.findByLabelText("编辑 workflows/main.py"), "dirty");
    for (const name of ["准备 Python 环境", "联网安装依赖"]) {
      await user.click(screen.getByRole("button", { name }));
    }
    expect(await screen.findByText("请先保存所有文件再安装依赖。")).toBeTruthy();
    expect(api.initializeWorkspace).not.toHaveBeenCalled();
  });
  it("saves the edited file with its original disk hash and restores tabs", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("treeitem", { name: "main.py" }));
    const editor = await screen.findByLabelText("编辑 workflows/main.py");
    await user.clear(editor); await user.type(editor, "changed");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith({ path: "workflows/main.py", content: "changed", expectedHash: "before" }));
    expect(JSON.parse(localStorage.getItem("hardwareharness.applications.test-project") ?? "{}").tabs).toEqual(["workflows/main.py"]);
  });
  it("blocks execution while any editor contains unsaved changes", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("treeitem", { name: "main.py" }));
    await user.type(await screen.findByLabelText("编辑 workflows/main.py"), "dirty");
    await user.click(screen.getByRole("button", { name: "运行脚本" }));
    expect(await screen.findByText("请先保存所有文件再运行。")).toBeTruthy();
    expect(startRun).not.toHaveBeenCalled();
  });
  it("recovers unsaved documents after leaving and reopening the workspace", async () => {
    const user = userEvent.setup();
    const first = mount();
    await user.click(await screen.findByRole("treeitem", { name: "main.py" }));
    const editor = await screen.findByLabelText("编辑 workflows/main.py");
    await user.clear(editor); await user.type(editor, "recover me");
    first.unmount();
    mount();
    await waitFor(() => expect((screen.getByLabelText("编辑 workflows/main.py") as HTMLTextAreaElement).value).toBe("recover me"));
    expect(writeFile).not.toHaveBeenCalled();
  });
  it("preserves dirty edits on external changes and requires an explicit resolution", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("treeitem", { name: "main.py" }));
    const editor = await screen.findByLabelText("编辑 workflows/main.py");
    await user.clear(editor); await user.type(editor, "local edit");
    readFile.mockResolvedValue({ path: "workflows/main.py", content: "external", hash: "remote" });
    await waitFor(() => expect(screen.getByRole("button", { name: "载入磁盘版本" })).toBeTruthy(), { timeout: 3500 });
    expect((editor as HTMLTextAreaElement).value).toBe("local edit");
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "保留编辑并合并" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith({ path: "workflows/main.py", content: "local edit", expectedHash: "remote" }));
  });
  it("submits new files with Enter and isolates the embedded preview", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("button", { name: "新建文件" }));
    const input = screen.getByLabelText("文件路径");
    await user.clear(input); await user.type(input, "workflows/new.py{Enter}");
    await waitFor(() => expect(createFile).toHaveBeenCalledWith({ path: "workflows/new.py", kind: "file", content: "" }));
    await user.selectOptions(screen.getByLabelText("选择应用"), "demo");
    await user.click(screen.getByRole("button", { name: "Web 预览" }));
    const frame = screen.getByTitle("应用 Web 预览");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.hasAttribute("preload")).toBe(false);
  });
});
