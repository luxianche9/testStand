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
