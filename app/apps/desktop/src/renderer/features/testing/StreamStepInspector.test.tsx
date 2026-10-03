// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hardware } from "@teststand/contracts/devices";
import type { TestPlan, TestStep } from "@teststand/contracts/testing";
import { StreamStepInspector } from "./StreamStepInspector.js";

afterEach(() => cleanup());

const hardware = [{ hardwareId: "scope", kind: "managed", label: "示波器" }] as unknown as Hardware[];

function plan(steps: TestStep[]): TestPlan {
  return {
    schemaVersion: 2, id: "plan", name: "Plan", description: "", revision: 1, parameters: [], requirements: [],
    stopOnFail: false, regions: { prepare: [], test: steps, cleanup: [] },
    createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z"
  };
}

function renderInspector(step: TestStep, update = vi.fn()) {
  const listStreams = vi.fn(async () => [{ id: "ch1", type: "f32" }]);
  Object.defineProperty(window, "teststand", {
    configurable: true, value: { streams: { listStreams } }
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invoke: TestStep = { id: "pulse", type: "InvokeTool", hardwareId: "scope", toolName: "pulse", anchor: "pulse" };
  render(
    <QueryClientProvider client={client}>
      <StreamStepInspector
        plan={plan([invoke, step])}
        step={step}
        hardware={hardware}
        catalogItem={undefined}
        references={[]}
        update={update}
      />
    </QueryClientProvider>
  );
  return { update, listStreams };
}

describe("stream step inspector", () => {
  it("picks the stream of the chosen device and writes the Observe anchor into its window", async () => {
    const step: TestStep = { id: "observe", type: "Observe", hardwareId: "scope", window: { anchor: "", endMs: 50 } };
    const { update, listStreams } = renderInspector(step);
    await waitFor(() => expect(screen.getByRole("option", { name: "ch1 · f32" })).toBeTruthy());
    expect(listStreams).toHaveBeenCalledWith({ hardwareId: "scope" });

    fireEvent.change(screen.getByRole("combobox", { name: /^数据流/ }), { target: { value: "ch1" } });
    expect(update).toHaveBeenLastCalledWith({ streamId: "ch1" });
    fireEvent.change(screen.getByRole("combobox", { name: /^锚点/ }), { target: { value: "pulse" } });
    expect(update).toHaveBeenLastCalledWith({ window: { anchor: "pulse", endMs: 50 } });
  });

  it("has no anchor for a Guard", () => {
    renderInspector({ id: "guard", type: "Guard", hardwareId: "scope", children: [] });
    expect(screen.queryByRole("combobox", { name: /^锚点/ })).toBeNull();
  });
});
