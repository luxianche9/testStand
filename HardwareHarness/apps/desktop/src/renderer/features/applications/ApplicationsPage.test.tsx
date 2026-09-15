// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "@hardwareharness/contracts/applications";
import { ApplicationsPage } from "./ApplicationsPage.js";

vi.mock("../../shared/CodeEditor.js", () => ({ CodeEditor: ({ value, path, onChange, onSave, readOnly }: {
  value: string; path: string; onChange: (content: string) => void; onSave: () => void; readOnly: boolean;
}) => <textarea aria-label={`编辑 ${path}`} value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
  if (event.ctrlKey && event.key === "s") { event.preventDefault(); onSave(); }
}} /> }));

const api = {
  listFiles: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), startRun: vi.fn(), cancelRun: vi.fn(),
  getRun: vi.fn(), runEvents: vi.fn(), initializeWorkspace: vi.fn()
};
const completed: RunRecord = { runId: "R1", name: "main.py", entrypoint: "scripts/main.py", inputs: {}, hardwareIds: [], status: "succeeded", startedAt: "2026-09-15T00:00:00Z", eventCount: 0, sourcePath: "source" };
const preferenceKey = "hardwareharness.applications.test-project";

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><ApplicationsPage /></QueryClientProvider>);
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  api.listFiles.mockResolvedValue([
    { path: "scripts", name: "scripts", kind: "directory" },
    { path: "scripts/main.py", name: "main.py", kind: "file" },
    { path: "scripts/helpers/other.py", name: "other.py", kind: "file" }
  ]);
  api.readFile.mockImplementation(async (path: string) => ({ path, content: "original", hash: "before" }));
  api.writeFile.mockImplementation(async (input: { path: string; content: string }) => ({ ...input, hash: "after" }));
  api.startRun.mockResolvedValue(completed);
  api.getRun.mockResolvedValue({ run: completed, events: [], hasMore: false });
  api.runEvents.mockResolvedValue([]);
  Object.defineProperty(window, "hardwareharness", { configurable: true, value: {
    applications: api, projects: { current: vi.fn(async () => ({ rootPath: "test-project", file: { projectId: "P" } })) },
    events: { subscribe: vi.fn(() => () => undefined) }
  } });
});
afterEach(cleanup);

describe("minimal Python workspace", () => {
  it("shows only the script list, editor, run control and collapsible terminal", async () => {
    mount();
    expect(await screen.findByRole("listbox", { name: "Python 脚本列表" })).toBeTruthy();
    expect((await screen.findByRole("button", { name: "运行" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["新建脚本", "运行", "终端"]);
    expect(screen.getByRole("button", { name: "终端" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("log")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.initializeWorkspace).not.toHaveBeenCalled();
  });

  it("saves all edited scripts before running directly without a configuration dialog", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("option", { name: "main.py" }));
    await user.clear(screen.getByLabelText("编辑 scripts/main.py"));
    await user.type(screen.getByLabelText("编辑 scripts/main.py"), "changed");
    await user.click(screen.getByRole("option", { name: "helpers/other.py" }));
    await user.type(await screen.findByLabelText("编辑 scripts/helpers/other.py"), " helper");
    await user.click(screen.getByRole("button", { name: "运行" }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledWith({ entrypoint: "scripts/helpers/other.py", name: "scripts/helpers/other.py", inputs: {}, hardwareIds: [] }));
    expect(api.writeFile).toHaveBeenCalledWith({ path: "scripts/main.py", content: "changed", expectedHash: "before" });
    expect(api.writeFile).toHaveBeenCalledTimes(2);
    expect(api.writeFile.mock.invocationCallOrder.at(-1)).toBeLessThan(api.startRun.mock.invocationCallOrder[0]!);
    expect(screen.getByRole("button", { name: "终端" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Ctrl+S saving and recovers unsaved drafts when reopening", async () => {
    const user = userEvent.setup(); const first = mount();
    await user.click(await screen.findByRole("option", { name: "main.py" }));
    const editor = await screen.findByLabelText("编辑 scripts/main.py");
    await user.clear(editor); await user.type(editor, "saved");
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(api.writeFile).toHaveBeenCalledWith({ path: "scripts/main.py", content: "saved", expectedHash: "before" }));
    api.readFile.mockImplementation(async (path: string) => ({ path, content: "saved", hash: "after" }));
    await user.type(editor, " draft");
    await user.click(screen.getByRole("button", { name: "终端" }));
    first.unmount(); mount();
    await waitFor(() => expect((screen.getByLabelText("编辑 scripts/main.py") as HTMLTextAreaElement).value).toBe("saved draft"));
    expect(screen.getByRole("button", { name: "终端" }).getAttribute("aria-expanded")).toBe("true");
    expect(api.writeFile).toHaveBeenCalledTimes(1);
  });

  it("reports save failures in the terminal and never runs stale code", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("option", { name: "main.py" }));
    await user.type(await screen.findByLabelText("编辑 scripts/main.py"), " changed");
    api.writeFile.mockRejectedValueOnce(new Error("Disk changed"));
    await user.click(screen.getByRole("button", { name: "运行" }));
    expect(await screen.findByText("Disk changed")).toBeTruthy();
    expect(api.startRun).not.toHaveBeenCalled();
    expect((screen.getByLabelText("编辑 scripts/main.py") as HTMLTextAreaElement).value).toBe("original changed");
  });

  it("preserves local edits when an external update is detected", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("option", { name: "main.py" }));
    await user.type(await screen.findByLabelText("编辑 scripts/main.py"), " local");
    api.readFile.mockImplementation(async (path: string) => ({ path, content: "remote", hash: "remote" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(preferenceKey)!).drafts[0].conflict?.hash).toBe("remote"), { timeout: 3500 });
    await user.click(screen.getByRole("button", { name: "运行" }));
    expect(await screen.findByText(/已在外部修改/)).toBeTruthy();
    expect(api.writeFile).not.toHaveBeenCalled();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("collects paginated stdout, stderr and log events in order and retains them when collapsed", async () => {
    const event = (sequence: number, type: string, data: Record<string, unknown>) => ({ runId: "R1", sequence, type, data, timestamp: "2026-09-15T00:00:00Z" });
    api.getRun.mockResolvedValue({ run: { ...completed, eventCount: 4 }, events: [event(1, "stdout", { text: "hello\n" })], hasMore: true });
    api.runEvents.mockResolvedValueOnce([
      event(2, "stderr", { text: "warning\n" }), event(3, "log", { message: "message" }), event(4, "run.completed", { result: { ok: true } })
    ]);
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("option", { name: "main.py" }));
    await user.click(screen.getByRole("button", { name: "运行" }));
    await waitFor(() => expect(screen.getByRole("log").textContent).toContain('hello\nwarning\nmessage\n'));
    expect(screen.getByRole("log").textContent).toContain('"ok": true');
    await user.click(screen.getByRole("button", { name: "终端" }));
    expect(screen.queryByRole("log")).toBeNull();
    await user.click(screen.getByRole("button", { name: "终端" }));
    expect(screen.getByRole("log").textContent).toContain("warning");
  });

  it("uses the same run control to stop an active script", async () => {
    api.startRun.mockResolvedValue({ ...completed, status: "running" });
    api.getRun.mockResolvedValue({ run: { ...completed, status: "running" }, events: [], hasMore: false });
    api.cancelRun.mockResolvedValue({ ...completed, status: "cancelled" });
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("option", { name: "main.py" }));
    await user.click(screen.getByRole("button", { name: "运行" }));
    await user.click(await screen.findByRole("button", { name: "停止" }));
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledWith("R1"));
  });
});
