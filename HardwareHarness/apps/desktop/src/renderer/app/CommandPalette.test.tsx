// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { dispatchAppCommand, onAppCommand } from "./commands";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";

afterEach(cleanup);

it("reports whether a page handled an app command", () => {
  expect(dispatchAppCommand("testing.run-all")).toBe(false);
  const handler = vi.fn();
  const off = onAppCommand("testing.run-all", handler);
  expect(dispatchAppCommand("wiring.new-connection")).toBe(false);
  expect(dispatchAppCommand("testing.run-all")).toBe(true);
  expect(handler).toHaveBeenCalledOnce();
  off();
  expect(dispatchAppCommand("testing.run-all")).toBe(false);
});

it("filters palette commands and runs the active one with Enter", async () => {
  const runWiring = vi.fn();
  const runTheme = vi.fn();
  const onOpenChange = vi.fn();
  const commands: PaletteCommand[] = [
    { id: "wiring", label: "前往 工位接线", group: "页面", run: runWiring },
    { id: "theme", label: "切换到浅色主题", group: "视图", keywords: "theme light", run: runTheme }
  ];
  render(<CommandPalette open onOpenChange={onOpenChange} commands={commands} />);

  expect(screen.getAllByRole("option")).toHaveLength(2);
  await userEvent.type(screen.getByRole("combobox", { name: "搜索命令" }), "light");
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["切换到浅色主题"]);
  await userEvent.keyboard("{Enter}");
  expect(runTheme).toHaveBeenCalledOnce();
  expect(runWiring).not.toHaveBeenCalled();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
