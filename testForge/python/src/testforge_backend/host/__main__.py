"""Desktop-owned child process entry point."""

from __future__ import annotations

import asyncio
import logging
import sys

from testforge_backend.host.rpc import StdioRpc
from testforge_backend.host.runtime import HostRuntime


async def serve() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    rpc = StdioRpc(sys.stdin.buffer, sys.stdout.buffer)
    runtime = HostRuntime(rpc)
    rpc.set_handler(runtime.dispatch, runtime.snapshot)
    rpc.start(asyncio.get_running_loop())
    try:
        await rpc.wait_closed()
    finally:
        await runtime.close()


def main() -> None:
    asyncio.run(serve())


if __name__ == "__main__":
    main()
