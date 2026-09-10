import { execFile } from "node:child_process";
import type { RemoteComputer } from "@testforge/contracts/devices";
import type { SshResult } from "./ssh.js";

/** The same bounded lifecycle interface as SSH, without requiring a local SSH daemon. */
export async function executeLocalShell(shell: RemoteComputer["ssh"]["shell"], script: string, timeoutMs: number): Promise<SshResult> {
  const started = Date.now();
  const executable = shell === "powershell" ? "powershell.exe" : "/bin/sh";
  const powershellScript = "$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); " + script;
  const args = shell === "powershell"
    ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(powershellScript, "utf16le").toString("base64")]
    : ["-c", script];
  return await new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== "number")) { reject(error); return; }
      resolve({ exitCode: error ? Number(error.code) : 0, stdout, stderr, truncated: false, durationMs: Date.now() - started });
    });
  });
}
