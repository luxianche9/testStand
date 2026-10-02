"""The two ways to reach a deploy target: SSH (SFTP + ``-EncodedCommand``) or this computer."""

from __future__ import annotations

import asyncio
import io
import shutil
from pathlib import Path
from typing import Any

from hardwareharness_backend.devices.local_shell import execute_local_shell
from hardwareharness_backend.devices.remote_shell import PowerShellRemoteShell

Record = dict[str, Any]
_QUIET = "$ProgressPreference = 'SilentlyContinue'\n"


def sftp_path(remote: str) -> str:
    """Windows OpenSSH names ``E:\\a\\b`` as ``/E:/a/b`` over SFTP."""
    return "/" + remote.replace("\\", "/")


class SshHost:
    def __init__(self, ssh: Any, computer: Record) -> None:
        self.ssh, self.computer = ssh, computer

    async def run(self, script: str, timeout_ms: int) -> Record:
        command = PowerShellRemoteShell().command(_QUIET + script)
        return dict(await self.ssh.execute(self.computer, command, timeout_ms, 1024 * 1024))

    async def upload(self, local: Path, remote: str) -> None:
        await self.ssh.sftp(
            self.computer, lambda session: session.put(str(local), sftp_path(remote))
        )

    async def write_file(self, remote: str, data: bytes) -> None:
        await self.ssh.sftp(
            self.computer, lambda session: session.putfo(io.BytesIO(data), sftp_path(remote))
        )


class LocalHost:
    """A service on the terminal's own computer (``execution: local``)."""

    async def run(self, script: str, timeout_ms: int) -> Record:
        return await execute_local_shell("powershell", script, timeout_ms)

    async def upload(self, local: Path, remote: str) -> None:
        target = Path(remote)
        target.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(shutil.copyfile, local, target)

    async def write_file(self, remote: str, data: bytes) -> None:
        target = Path(remote)
        target.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(target.write_bytes, data)
