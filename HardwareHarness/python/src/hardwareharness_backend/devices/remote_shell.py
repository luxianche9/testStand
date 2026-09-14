from __future__ import annotations

import base64
from typing import Any, Protocol


class RemoteShell(Protocol):
    kind: str

    def command(self, script: str) -> str: ...
    def probe_command(self) -> str: ...
    def read_logs_command(self, path: str, lines: int) -> str: ...


class PowerShellRemoteShell:
    kind = "powershell"

    def command(self, script: str) -> str:
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        return f"powershell -NoProfile -NonInteractive -EncodedCommand {encoded}"

    def probe_command(self) -> str:
        return "$PSVersionTable.PSVersion.Major"

    def read_logs_command(self, path: str, lines: int) -> str:
        literal = path.replace("'", "''")
        return (
            f"Get-ChildItem -LiteralPath '{literal}' -Filter '*.log' -File "
            "-ErrorAction SilentlyContinue | Sort-Object LastWriteTime | ForEach-Object { "
            "'===== ' + $_.Name + ' ====='; Get-Content -LiteralPath $_.FullName "
            f"-Tail {lines} -ErrorAction SilentlyContinue }}"
        )


class PosixRemoteShell:
    kind = "posix"

    def command(self, script: str) -> str:
        return f"sh -lc {_quote(script)}"

    def probe_command(self) -> str:
        return "printf hardwareharness-shell-ready"

    def read_logs_command(self, path: str, lines: int) -> str:
        return (
            f'for file in {_quote(path.removesuffix("/"))}/*.log; do [ -f "$file" ] '
            '|| continue; printf \'===== %s =====\\n\' "$(basename "$file")"; '
            f'tail -n {lines} -- "$file"; done'
        )


def _quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def remote_shell_for(computer: dict[str, Any]) -> RemoteShell:
    return (
        PowerShellRemoteShell() if computer["ssh"]["shell"] == "powershell" else PosixRemoteShell()
    )
