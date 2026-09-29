// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../ui/toast";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunLogPage } from "./RunLogPage.js";
import { installTestingApi, makeItem, makePlan, makeSummary } from "./testing-api.fixture.js";

const plan = makePlan();
let api: ReturnType<typeof installTestingApi>;

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}><ToastProvider>{children}</ToastProvider></QueryClientProvider>;
}

beforeEach(() => {
  api = installTestingApi([plan], [makeItem("plan", plan.name)]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("RunLogPage", () => {
  it("lists every run, appends and deduplicates history pages", async () => {
    const first = makeSummary("run-1", `${plan.name} run-1`, "2026-09-18T00:00:00Z");
    const second = makeSummary("run-2", `${plan.name} run-2`, "2026-09-17T00:00:00Z");
    api.testing.listRuns.mockImplementation(async (input?: { cursor?: string }) => input?.cursor
      ? { items: [first, second] }
      : { items: [first], nextCursor: "page-2" });
    render(<RunLogPage />, { wrapper: Wrapper });
    expect(await screen.findByText(`${plan.name} run-1`)).toBeTruthy();
    expect(api.testing.listRuns).toHaveBeenCalledWith(expect.not.objectContaining({ planId: expect.anything() }));
    await userEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText(`${plan.name} run-2`)).toBeTruthy();
    expect(screen.getAllByText(`${plan.name} run-1`)).toHaveLength(1);
  });
});
