import { describe, expect, it, vi } from "vitest";
import { HardwareOccupancyManager } from "./hardware-occupancy.js";

describe("HardwareOccupancyManager", () => {
  it("acquires a per-hardware lease and reports loss when remote ownership changes", async () => {
    let current: Record<string, unknown> = { state: "unoccupied" };
    const transports = {
      callInternal: vi.fn(async (_server, _name, args: Record<string, unknown>) => {
        if (args.action === "acquire") {
          current = {
            state: "occupied", holderId: args.holderId, holderLabel: args.holderLabel,
            acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15_000).toISOString()
          };
        } else if (args.action === "release") current = { state: "unoccupied" };
        return current;
      })
    };
    const store = { listServers: () => [{ serverId: "S1", hardwareId: "H1", enabled: true, transport: "mcp-http" }] };
    const manager = new HardwareOccupancyManager(store as never, transports as never);
    const lost = vi.fn();
    manager.setLostNotifier(lost);

    const acquired = await manager.acquire("H1");
    expect(acquired.state).toBe("occupied_by_self");
    expect(manager.requireLease("H1")).toEqual(expect.any(String));

    current = { state: "occupied", holderId: "another-client", holderLabel: "Other", expiresAt: new Date(Date.now() + 15_000).toISOString() };
    await manager.refresh("H1");
    expect(lost).toHaveBeenCalledWith("H1", expect.stringContaining("no longer owned"));
    expect(() => manager.requireLease("H1")).toThrow(/must be occupied/);
    await manager.close();
  });
});
