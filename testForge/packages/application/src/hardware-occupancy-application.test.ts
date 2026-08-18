import { describe, expect, it } from "vitest";
import { AGENT_REQUEST_CONTEXT, HUMAN_REQUEST_CONTEXT } from "./authorization.js";
import { DefaultAuthorizer } from "./authorization.js";
import { HardwareOccupancyApplication } from "./hardware-occupancy-application.js";

function fixture(options: { failOn?: string; busy?: string } = {}) {
  const held = new Set(["H1"]);
  const acquired: string[] = [];
  const released: string[] = [];
  const occupancy = {
    list: () => ["H1", "H2", "H3"].map((hardwareId) => ({ hardwareId, state: held.has(hardwareId) ? "occupied_by_self" as const : "unoccupied" as const })),
    refreshAll: async () => occupancy.list(),
    isHeld: (hardwareId: string) => held.has(hardwareId),
    acquire: async (hardwareId: string) => {
      if (hardwareId === options.failOn) throw new Error("remote conflict");
      held.add(hardwareId); acquired.push(hardwareId);
      return { hardwareId, state: "occupied_by_self" as const };
    },
    release: async (hardwareId: string) => {
      held.delete(hardwareId); released.push(hardwareId);
      return { hardwareId, state: "unoccupied" as const };
    }
  };
  const devices = {
    occupancy,
    listServers: () => ["H1", "H2", "H3"].map((hardwareId) => ({ hardwareId, enabled: true }))
  };
  const execution = { isHardwareBusy: (hardwareId: string) => hardwareId === options.busy };
  const application = new HardwareOccupancyApplication(new DefaultAuthorizer(), devices as never, execution as never);
  return { application, held, acquired, released };
}

describe("HardwareOccupancyApplication", () => {
  it("allows AI to request occupancy but never to acquire or release it", async () => {
    const { application } = fixture();
    const request = application.request(AGENT_REQUEST_CONTEXT, { hardwareIds: ["H2", "H1"], reason: "run test" });
    expect(request.hardwareIds).toEqual(["H1", "H2"]);
    await expect(application.acquire(AGENT_REQUEST_CONTEXT, "H2")).rejects.toMatchObject({ category: "permission_denied" });
    await expect(application.release(AGENT_REQUEST_CONTEXT, "H1")).rejects.toMatchObject({ category: "permission_denied" });
  });

  it("rolls back only leases gained by the current batch attempt", async () => {
    const { application, held, acquired, released } = fixture({ failOn: "H3" });
    const request = application.request(AGENT_REQUEST_CONTEXT, { hardwareIds: ["H1", "H2", "H3"] });
    await expect(application.acquireRequest(HUMAN_REQUEST_CONTEXT, request.occupancyRequestId)).rejects.toMatchObject({ category: "conflict" });
    expect(acquired).toEqual(["H2"]);
    expect(released).toEqual(["H2"]);
    expect(held.has("H1")).toBe(true);
    expect(application.getRequest(HUMAN_REQUEST_CONTEXT, request.occupancyRequestId)).toMatchObject({ status: "pending", message: expect.stringContaining("remote conflict") });
  });

  it("confirms a successful batch and blocks release while hardware executes", async () => {
    const { application } = fixture({ busy: "H1" });
    const request = application.request(AGENT_REQUEST_CONTEXT, { hardwareIds: ["H1", "H2"] });
    await expect(application.acquireRequest(HUMAN_REQUEST_CONTEXT, request.occupancyRequestId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(application.release(HUMAN_REQUEST_CONTEXT, "H1")).rejects.toMatchObject({ category: "conflict" });
  });
});
