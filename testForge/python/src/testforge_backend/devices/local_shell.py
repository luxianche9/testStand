from __future__ import annotations

import asyncio
import base64
import subprocess
import sys
import time
from typing import Any


async def execute_local_shell(shell: str, script: str, timeout_ms: int) -> dict[str, Any]:
    if shell == "powershell":
        script = (
            "$ProgressPreference = 'SilentlyContinue'; "
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); " + script
        )
        command = [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            base64.b64encode(script.encode("utf-16-le")).decode("ascii"),
        ]
    else:
        command = ["/bin/sh", "-c", script]
    started = time.monotonic()
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )

    async def read(stream: asyncio.StreamReader | None) -> bytes:
        assert stream is not None
        chunks: list[bytes] = []
        size = 0
        while chunk := await stream.read(65536):
            size += len(chunk)
            if size > 2 * 1024 * 1024:
                raise RuntimeError("maxBuffer length exceeded")
            chunks.append(chunk)
        return b"".join(chunks)

    readers = [asyncio.create_task(read(process.stdout)), asyncio.create_task(read(process.stderr))]
    try:
        async with asyncio.timeout(timeout_ms / 1000):
            stdout, stderr = await asyncio.gather(*readers)
            await process.wait()
    finally:
        if process.returncode is None:
            process.kill()
        for reader in readers:
            reader.cancel()
        await asyncio.gather(*readers, return_exceptions=True)
        await process.wait()
    return {
        "exitCode": process.returncode,
        "stdout": stdout.decode("utf-8", errors="replace"),
        "stderr": stderr.decode("utf-8", errors="replace"),
        "truncated": False,
        "durationMs": round((time.monotonic() - started) * 1000),
    }
