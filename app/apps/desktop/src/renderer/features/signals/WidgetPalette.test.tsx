// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WIDGET_MIME } from "./dnd.js";
import { onWidgetRequested, WidgetPalette } from "./WidgetPalette.js";

afterEach(cleanup);

describe("WidgetPalette", () => {
  it("lists every widget as one row with its hint, placed on click or dragged by its kind", () => {
    const onPlace = vi.fn();
    const requested = vi.fn();
    const stop = onWidgetRequested(requested);
    render(<WidgetPalette onPlace={onPlace} />);
    const list = within(screen.getByRole("region", { name: "控件" })).getByRole("list");
    expect(list.className).toContain("grid-cols-[minmax(0,1fr)]");
    const rows = within(list).getAllByRole("button");
    expect(rows).toHaveLength(6);
    expect(rows[0]?.textContent).toContain("曲线");

    fireEvent.click(rows[0]!);
    expect(onPlace).toHaveBeenCalledOnce();
    expect(requested).toHaveBeenCalledWith("scope");

    const setData = vi.fn();
    fireEvent.dragStart(rows[1]!, { dataTransfer: { setData, effectAllowed: "" } });
    expect(setData).toHaveBeenCalledWith(WIDGET_MIME, "value");
    stop();
  });
});
