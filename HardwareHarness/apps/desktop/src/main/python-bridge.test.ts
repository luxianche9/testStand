import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PythonBridge } from "./python-bridge.js";
import { decodeProcessValue, encodeProcessValue } from "./python-codec.js";

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn()
  });
  const hostCall = vi.fn(async (_method: string, params: unknown) => params);
  const event = vi.fn();
  const bridge = new PythonBridge(child as never, { hostCall, event, log: vi.fn() });
  const frames: Record<string, unknown>[] = [];
  child.stdin.on("data", (chunk: Buffer) => frames.push(JSON.parse(chunk.toString())));
  const reply = (frame: Record<string, unknown>) => child.stdout.write(JSON.stringify(frame) + "\n");
  return { child, hostCall, event, bridge, frames, reply };
}

describe("Python bridge", () => {
  it("matches out-of-order replies and applies internal state before resolving", async () => {
    const { bridge, frames, reply } = fixture();
    const first = bridge.call("one", { value: 1 });
    const second = bridge.call("two", { value: 2 });
    reply({ id: frames[1]?.id, result: encodeProcessValue(2), state: encodeProcessValue({ generation: 2 }) });
    expect(await second).toBe(2);
    expect(bridge.state).toMatchObject({ generation: 2 });
    reply({ id: frames[0]?.id, result: encodeProcessValue(1), state: encodeProcessValue({ generation: 1 }) });
    expect(await first).toBe(1);
    expect(bridge.state).toMatchObject({ generation: 2 });
  });

  it("handles safeStorage callbacks while an outer business call is pending", async () => {
    const { bridge, frames, reply, hostCall } = fixture();
    const pending = bridge.call("save", {});
    reply({ id: "python:1", method: "host.safeStorage.encrypt", params: encodeProcessValue({ value: "plain" }) });
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(hostCall).toHaveBeenCalledWith("host.safeStorage.encrypt", { value: "plain" });
    expect(decodeProcessValue(frames[1]?.result)).toEqual({ value: "plain" });
    reply({ id: frames[0]?.id, result: encodeProcessValue(undefined) });
    await pending;
  });

  it("decodes split UTF-8 frames and publishes events in stream order", () => {
    const { child, event } = fixture();
    const frame = Buffer.from(JSON.stringify({ method: "desktop.event", params: encodeProcessValue({ event: "project", payload: "中文" }) }) + "\n");
    const cut = frame.indexOf(Buffer.from("中")) + 1;
    child.stdout.write(frame.subarray(0, cut));
    expect(event).not.toHaveBeenCalled();
    child.stdout.write(frame.subarray(cut));
    expect(event).toHaveBeenCalledWith("project", "中文");
  });

  it("applies project state before notifying a workspace switch exactly once", () => {
    const { bridge, reply, event } = fixture();
    event.mockImplementation((name, payload, changed) => {
      expect(name).toBe("project");
      expect(changed).toBe(true);
      expect(bridge.state.project).toEqual(payload);
    });
    reply({ method: "desktop.event", params: encodeProcessValue({
      event: "project", payload: { rootPath: "E:/project" }, workspaceChanged: true,
      state: { generation: 4, project: { rootPath: "E:/project" } }
    }) });
    expect(event).toHaveBeenCalledOnce();
  });

  it("restores domain errors and rejects every pending request on process exit", async () => {
    const { bridge, frames, reply, child } = fixture();
    const failed = bridge.call("bad", {});
    reply({ id: frames[0]?.id, error: encodeProcessValue({ category: "conflict", message: "busy", details: { hardwareId: "H" } }), state: encodeProcessValue({ generation: 3, settings: { llm: { model: "committed" } }, gatewayToken: "rotated" }) });
    await expect(failed).rejects.toMatchObject({ name: "AppError", category: "conflict", details: { hardwareId: "H" } });
    expect(bridge.state).toMatchObject({ settings: { llm: { model: "committed" } }, gatewayToken: "rotated" });
    const pending = bridge.call("wait", {});
    child.emit("exit", 1, null);
    await expect(pending).rejects.toMatchObject({ category: "unavailable" });
    await expect(bridge.call("again", {})).rejects.toMatchObject({ category: "unavailable" });
  });

  it("closes stdin and waits for exit even when cleanup rejects", async () => {
    const { bridge, frames, reply, child } = fixture();
    const shutdown = bridge.shutdown();
    const rejected = expect(shutdown).rejects.toMatchObject({ message: "flush failed" });
    reply({ id: frames[0]?.id, error: encodeProcessValue({ category: "error", message: "flush failed" }) });
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true));
    child.emit("exit", 1, null);
    await rejected;
  });
});
