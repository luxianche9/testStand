// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useResizableWidth } from "./resizable.js";

function Panel({ storageKey = "panel-a", direction = "right" }: { storageKey?: string; direction?: "left" | "right" }) {
  const panel = useResizableWidth({ storageKey, defaultWidth: 300, min: 200, max: 520, direction });
  return <div role="separator" data-width={panel.width} {...panel.handleProps} />;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("PointerEvent", MouseEvent);
  HTMLElement.prototype.setPointerCapture = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("restores dragged widths after unmount and keeps separate panels independent", () => {
  const first = render(<Panel />);
  fireEvent.pointerDown(screen.getByRole("separator"), { clientX: 300, button: 0 });
  fireEvent.pointerMove(screen.getByRole("separator"), { clientX: 380 });
  fireEvent.pointerUp(screen.getByRole("separator"));
  first.unmount();
  const second = render(<Panel storageKey="panel-b" direction="left" />);
  expect(screen.getByRole("separator").dataset.width).toBe("300");
  fireEvent.pointerDown(screen.getByRole("separator"), { clientX: 400, button: 0 });
  fireEvent.pointerMove(screen.getByRole("separator"), { clientX: 340 });
  second.unmount();
  expect(document.body.classList.contains("resizing-col")).toBe(false);
  const restored = render(<Panel />);
  expect(screen.getByRole("separator").dataset.width).toBe("380");
  restored.unmount();
  render(<Panel storageKey="panel-b" />);
  expect(screen.getByRole("separator").dataset.width).toBe("360");
});

it.each([["NaN", "300"], ["", "300"], ["9999", "520"], ["-5", "200"]])(
  "restores a safe width from %s", (saved, expected) => {
    localStorage.setItem("panel-a", saved);
    render(<Panel />);
    expect(screen.getByRole("separator").dataset.width).toBe(expected);
  }
);

function Sidebar() {
  const panel = useResizableWidth({
    storageKey: "sidebar", defaultWidth: 420, min: 300,
    max: () => Math.min(720, window.innerWidth - 468), direction: "left"
  });
  return <div aria-label="侧栏" data-width={panel.width} {...panel.separatorProps} />;
}

it("resizes with the keyboard and clamps to a viewport-relative maximum", () => {
  vi.stubGlobal("innerWidth", 1400);
  render(<Sidebar />);
  const separator = screen.getByRole("separator", { name: "侧栏" });
  fireEvent.keyDown(separator, { key: "Home" });
  expect(separator.getAttribute("aria-valuenow")).toBe("300");
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(separator.dataset.width).toBe("316");
  fireEvent.keyDown(separator, { key: "End" });
  expect(separator.dataset.width).toBe("720");
  vi.stubGlobal("innerWidth", 960);
  fireEvent(window, new Event("resize"));
  expect(separator.dataset.width).toBe("492");
  expect(separator.getAttribute("aria-valuemax")).toBe("492");
  expect(localStorage.getItem("sidebar")).toBe("492");
  fireEvent.doubleClick(separator);
  expect(separator.dataset.width).toBe("420");
});
