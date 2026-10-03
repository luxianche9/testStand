import { describe, expect, it, vi } from "vitest";
import { createOpenCodeAuthorization } from "./opencode-auth.js";

const backend = "http://127.0.0.1:5000";
const connection = { url: "http://127.0.0.1:4096", username: "opencode", password: "sidecar-secret" };
const basic = `Basic ${Buffer.from("opencode:sidecar-secret").toString("base64")}`;

describe("OpenCode renderer authorization", () => {
  it("injects Basic auth only for the current OpenCode origin", async () => {
    const fetchConnection = vi.fn(async () => connection);
    const authorize = createOpenCodeAuthorization(backend, fetchConnection);
    await expect(authorize("http://127.0.0.1:4096/session", { Accept: "text/event-stream" })).resolves.toEqual({
      Accept: "text/event-stream",
      Authorization: basic
    });
    await authorize("http://127.0.0.1:4096/global/event", {});
    expect(fetchConnection).toHaveBeenCalledOnce();
    const foreign = { Authorization: "Bearer keep-me" };
    await expect(authorize("http://127.0.0.1:4097/session", foreign)).resolves.toBe(foreign);
  });

  it("never asks about the backend's own requests", async () => {
    const fetchConnection = vi.fn(async () => connection);
    const headers = { authorization: "Bearer api" };
    await expect(createOpenCodeAuthorization(backend, fetchConnection)(`${backend}/api/ops/system.dashboard`, headers)).resolves.toBe(headers);
    expect(fetchConnection).not.toHaveBeenCalled();
  });

  it("follows OpenCode to its new port after a restart and replaces stale headers", async () => {
    const fetchConnection = vi.fn()
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce({ ...connection, url: "http://127.0.0.1:4100" });
    const authorize = createOpenCodeAuthorization(backend, fetchConnection);
    await authorize("http://127.0.0.1:4096/session", {});
    const result = await authorize("http://127.0.0.1:4100/session", { authorization: "stale" });
    expect(result.authorization).toBeUndefined();
    expect(result.Authorization).toBe(basic);
  });

  it("leaves requests alone while OpenCode is stopped or the backend is unreachable", async () => {
    const stopped = createOpenCodeAuthorization(backend, async () => null);
    await expect(stopped("http://127.0.0.1:4096/session", {})).resolves.toEqual({});
    const failing = createOpenCodeAuthorization(backend, async () => { throw new Error("down"); });
    await expect(failing("http://127.0.0.1:4096/session", {})).resolves.toEqual({});
  });
});
