import type { OpenCodeRuntimeStatus } from "@hardwareharness/contracts/agents";
import { describe, expect, it, vi } from "vitest";
import { autoStartOpenCode, reconcileOpenCodeSettings, reconcileOpenCodeWorkspace, type OpenCodeLifecycleRuntime } from "./opencode-lifecycle.js";

function runtime(initial: OpenCodeRuntimeStatus["state"] = "stopped") {
  let state = initial;
  const control: OpenCodeLifecycleRuntime = {
    status: () => ({ state }),
    start: vi.fn(async () => { state = "running"; }),
    restart: vi.fn(async () => { state = "running"; }),
    stop: vi.fn(async () => { state = "stopped"; })
  };
  return control;
}

const configured = { baseUrl: "https://api.example.test/v1", model: "model-a", apiKey: "secret-a" };

describe("OpenCode lifecycle coordination", () => {
  it("automatically starts after window creation when a key is configured", async () => {
    const control = runtime();
    await expect(autoStartOpenCode(control, "secret-a")).resolves.toBe("start");
    expect(control.start).toHaveBeenCalledOnce();
  });

  it("skips automatic startup without a key and does not create an error state", async () => {
    const control = runtime();
    await expect(autoStartOpenCode(control, undefined)).resolves.toBe("none");
    expect(control.start).not.toHaveBeenCalled();
  });

  it("keeps OpenCode stopped at startup until a project is open", async () => {
    const control = runtime();
    await expect(autoStartOpenCode(control, "secret-a", false)).resolves.toBe("none");
    expect(control.start).not.toHaveBeenCalled();
  });

  it("starts for an opened project, restarts for a switched project, and stops after leaving", async () => {
    const control = runtime();
    await expect(reconcileOpenCodeWorkspace(control, true, "secret-a")).resolves.toBe("start");
    await expect(reconcileOpenCodeWorkspace(control, true, "secret-a")).resolves.toBe("restart");
    await expect(reconcileOpenCodeWorkspace(control, false, "secret-a")).resolves.toBe("stop");
    expect(control.start).toHaveBeenCalledOnce();
    expect(control.restart).toHaveBeenCalledOnce();
    expect(control.stop).toHaveBeenCalledOnce();
  });

  it("starts after the first valid key is saved", async () => {
    const control = runtime();
    await expect(reconcileOpenCodeSettings(control, { ...configured, apiKey: undefined }, configured)).resolves.toBe("start");
    expect(control.start).toHaveBeenCalledOnce();
  });

  it("does not start after saving a key while no project is open", async () => {
    const control = runtime();
    await expect(reconcileOpenCodeSettings(control, { ...configured, apiKey: undefined }, configured, false)).resolves.toBe("none");
    expect(control.start).not.toHaveBeenCalled();
  });

  it("restarts a running instance when address, model, or key changes", async () => {
    const control = runtime("running");
    await expect(reconcileOpenCodeSettings(control, configured, { ...configured, model: "model-b" })).resolves.toBe("restart");
    expect(control.restart).toHaveBeenCalledOnce();
  });

  it("stops a running instance when the key is cleared", async () => {
    const control = runtime("running");
    await expect(reconcileOpenCodeSettings(control, configured, { ...configured, apiKey: undefined })).resolves.toBe("stop");
    expect(control.stop).toHaveBeenCalledOnce();
  });

  it("keeps an intentionally stopped configured instance stopped when settings are unchanged", async () => {
    const control = runtime("stopped");
    await expect(reconcileOpenCodeSettings(control, configured, configured)).resolves.toBe("none");
    expect(control.start).not.toHaveBeenCalled();
    expect(control.restart).not.toHaveBeenCalled();
  });
});
