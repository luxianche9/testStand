// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function BrokenFeature(): never {
  throw new Error("Loading chunk failed");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("offers an application reload when a lazy feature fails", async () => {
  const onReload = vi.fn();
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  render(
    <ErrorBoundary onReload={onReload}>
      <BrokenFeature />
    </ErrorBoundary>
  );

  expect(screen.getByRole("alert").textContent).toContain("页面资源可能已更新");
  await userEvent.click(screen.getByRole("button", { name: "重新加载应用" }));
  expect(onReload).toHaveBeenCalledOnce();
});
