import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn(),
  fetch: vi.fn()
}));

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: electron.registerSchemesAsPrivileged,
    handle: electron.handle
  },
  net: { fetch: electron.fetch }
}));

import { registerAssetProtocol, registerAssetScheme } from "./protocols.js";

type ProtocolHandler = (request: Request) => Promise<Response>;

describe("asset protocol", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers a secure standard fetch-capable scheme", () => {
    registerAssetScheme();

    expect(electron.registerSchemesAsPrivileged).toHaveBeenCalledWith([{
      scheme: "hardwareharness-asset",
      privileges: { secure: true, standard: true, supportFetchAPI: true }
    }]);
  });

  it("resolves encoded hardware assets through Electron net.fetch", async () => {
    const resolveImagePath = vi.fn(() => "C:\\assets\\front panel.png");
    electron.fetch.mockResolvedValue(new Response("image", { status: 200 }));
    registerAssetProtocol(resolveImagePath);
    const handler = electron.handle.mock.calls[0]?.[1] as ProtocolHandler;

    const response = await handler(new Request("hardwareharness-asset://local/HW%201/front%20panel.png"));

    expect(resolveImagePath).toHaveBeenCalledWith("HW 1", "front panel.png");
    expect(electron.fetch).toHaveBeenCalledWith(expect.stringMatching(/^file:/));
    expect(response.status).toBe(200);
  });

  it("returns bounded errors for missing paths and rejected file fetches", async () => {
    registerAssetProtocol(() => "C:\\outside\\asset.png");
    const handler = electron.handle.mock.calls[0]?.[1] as ProtocolHandler;

    expect((await handler(new Request("hardwareharness-asset://local/HW"))).status).toBe(404);
    electron.fetch.mockRejectedValueOnce(new Error("blocked"));
    expect((await handler(new Request("hardwareharness-asset://local/HW/asset.png"))).status).toBe(403);
  });
});
