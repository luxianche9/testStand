import { describe, expect, it } from "vitest";
import { hardwareSchema, remoteComputerSchema } from "./devices.js";
import { projectFileSchema } from "./projects.js";

describe("public contracts", () => {
  it("rejects passive hardware that references remote infrastructure", () => {
    expect(() => hardwareSchema.parse({ formatVersion: 2, hardwareId: "DUT", label: "DUT", kind: "passive", serverId: "S1", computerId: "PC1", ports: [] })).toThrow();
  });

  it("applies stable defaults", () => {
    expect(remoteComputerSchema.parse({ id: "PC1", label: "PC", address: "127.0.0.1", ssh: { username: "user" } }).ssh.port).toBe(22);
  });

  it("requires the current project format", () => {
    expect(() => projectFileSchema.parse({ formatVersion: 2 })).toThrow();
  });
});
