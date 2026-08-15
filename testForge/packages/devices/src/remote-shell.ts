import type { RemoteComputer } from "@testforge/contracts/devices";

export interface RemoteShell {
  readonly kind: RemoteComputer["ssh"]["shell"];
  command(script: string): string;
  probeCommand(): string;
  readLogsCommand(path: string, lines: number): string;
}

export class PowerShellRemoteShell implements RemoteShell {
  readonly kind = "powershell" as const;

  command(script: string): string {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  }

  probeCommand(): string { return "$PSVersionTable.PSVersion.Major"; }

  readLogsCommand(path: string, lines: number): string {
    const literal = path.replace(/'/g, "''");
    return `Get-ChildItem -LiteralPath '${literal}' -Filter '*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | ForEach-Object { '===== ' + $_.Name + ' ====='; Get-Content -LiteralPath $_.FullName -Tail ${lines} -ErrorAction SilentlyContinue }`;
  }
}

export class PosixRemoteShell implements RemoteShell {
  readonly kind = "posix" as const;

  command(script: string): string { return `sh -lc ${shellQuote(script)}`; }
  probeCommand(): string { return "printf testforge-shell-ready"; }

  readLogsCommand(path: string, lines: number): string {
    return `for file in ${shellQuote(path.replace(/\/$/, ""))}/*.log; do [ -f "$file" ] || continue; printf '===== %s =====\\n' "$(basename "$file")"; tail -n ${lines} -- "$file"; done`;
  }
}

const SHELLS: Record<RemoteComputer["ssh"]["shell"], RemoteShell> = {
  powershell: new PowerShellRemoteShell(),
  posix: new PosixRemoteShell()
};

export function remoteShellFor(computer: RemoteComputer): RemoteShell { return SHELLS[computer.ssh.shell]; }

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
