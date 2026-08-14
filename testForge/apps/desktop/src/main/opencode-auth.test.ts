import { describe, expect, it } from "vitest";
import { injectOpenCodeAuthorization } from "./opencode-auth.js";

describe("OpenCode renderer authorization", () => {
  const connection = { url: "http://127.0.0.1:4096", password: "sidecar-secret" };

  it("injects Basic auth only for the current sidecar origin", () => {
    expect(injectOpenCodeAuthorization("http://127.0.0.1:4096/session", { Accept: "text/event-stream" }, connection)).toEqual({
      Accept: "text/event-stream",
      Authorization: `Basic ${Buffer.from("opencode:sidecar-secret").toString("base64")}`
    });
    const foreign = { Authorization: "Bearer keep-me" };
    expect(injectOpenCodeAuthorization("http://127.0.0.1:4097/session", foreign, connection)).toBe(foreign);
  });

  it("replaces differently-cased authorization headers on the matching origin", () => {
    const result = injectOpenCodeAuthorization("http://127.0.0.1:4096/global/event", { authorization: "stale" }, connection);
    expect(result.authorization).toBeUndefined();
    expect(result.Authorization).toMatch(/^Basic /);
  });
});
