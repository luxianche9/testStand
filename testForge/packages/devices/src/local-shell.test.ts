import { describe, expect, it } from "vitest";
import { remoteComputerSchema } from "@testforge/contracts/devices";
import { executeLocalShell } from "./local-shell.js";

const shell = process.platform === "win32" ? "powershell" : "posix";

describe("local lifecycle shell", () => {
  it("captures stdout and nonzero exit codes without an SSH credential", async () => {
    const result = await executeLocalShell(shell, shell === "powershell" ? "Write-Output 'local-ready'; exit 7" : "printf local-ready; exit 7", 10000);
    expect(result.stdout.trim()).toBe("local-ready");
    expect(result.exitCode).toBe(7);
  });
  it("enforces a deadline", async () => {
    await expect(executeLocalShell(shell, shell === "powershell" ? "Start-Sleep -Seconds 10" : "sleep 10", 200)).rejects.toThrow();
  });
  it("requires explicit local execution and a loopback address", () => {
    const remote = { id: "PC", label: "PC", address: "192.168.1.4", ssh: { port: 22, username: "user", shell } };
    expect(remoteComputerSchema.parse(remote).execution).toBeUndefined();
    expect(remoteComputerSchema.safeParse({ ...remote, execution: "local" }).success).toBe(false);
    expect(remoteComputerSchema.parse({ ...remote, execution: "local", address: "127.0.0.1" }).execution).toBe("local");
  });
});
