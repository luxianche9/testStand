import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { PosixRemoteShell, PowerShellRemoteShell } from "./remote-shell.js";

describe("RemoteShell", () => {
  it("encodes PowerShell scripts without teaching SSH about Windows", () => {
    const shell = new PowerShellRemoteShell();
    const command = shell.command("Write-Output '测试'");
    const encoded = command.split(" ").at(-1)!;
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe("Write-Output '测试'");
  });

  it("builds POSIX probe and log commands without PowerShell syntax", () => {
    const shell = new PosixRemoteShell();
    expect(shell.command(shell.probeCommand())).toMatch(/^sh -lc /);
    expect(shell.readLogsCommand("/var/log/test forge", 25)).toContain("'/var/log/test forge'/*.log");
    expect(shell.readLogsCommand("/var/log/test forge", 25)).not.toContain("Get-ChildItem");
  });
});
