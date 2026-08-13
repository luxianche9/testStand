// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { THREAD_DRAWER_STORAGE_KEY, usePersistedThreadDrawer } from "./drawer";

function Harness({ enabled = true }: { enabled?: boolean }) {
  const [open, setOpen] = usePersistedThreadDrawer(enabled);
  return <><output aria-label="抽屉状态">{open ? "打开" : "关闭"}</output><button onClick={() => setOpen(true)}>打开</button></>;
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("thread drawer state", () => {
  it("defaults closed, persists state, and supports Ctrl/Cmd+B plus Escape", () => {
    render(<Harness />);
    expect(screen.getByLabelText("抽屉状态").textContent).toBe("关闭");
    expect(localStorage.getItem(THREAD_DRAWER_STORAGE_KEY)).toBe("false");
    act(() => { fireEvent.keyDown(window, { key: "b", ctrlKey: true }); });
    expect(screen.getByLabelText("抽屉状态").textContent).toBe("打开");
    expect(localStorage.getItem(THREAD_DRAWER_STORAGE_KEY)).toBe("true");
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(screen.getByLabelText("抽屉状态").textContent).toBe("关闭");
  });

  it("restores the persisted open state", () => {
    localStorage.setItem(THREAD_DRAWER_STORAGE_KEY, "true");
    render(<Harness />);
    expect(screen.getByLabelText("抽屉状态").textContent).toBe("打开");
  });
});
