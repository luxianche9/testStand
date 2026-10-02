"""Service process entry point (design doc §9.4).

The main process starts the service with the profile directory and reads exactly one
stdout line, ``{"port", "token", "hostToken", "version"}``; everything after that is HTTP
and SSE. Logs go to stderr. When stdin closes (the main process quit or crashed) the
service releases every device to its safe state and exits.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import threading
from pathlib import Path

from hardwareharness_backend.host.runtime import HostRuntime, ServiceOptions


def parse_options(argv: list[str] | None = None) -> ServiceOptions:
    parser = argparse.ArgumentParser(prog="hardwareharness-backend")
    parser.add_argument("--user-data", default=os.environ.get("HARDWAREHARNESS_USER_DATA_DIR"))
    parser.add_argument(
        "--gateway-port",
        type=int,
        default=int(os.environ.get("HARDWAREHARNESS_GATEWAY_PORT", 8000)),
    )
    parser.add_argument(
        "--integration-test-mode",
        action="store_true",
        default=os.environ.get("HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE") == "1",
    )
    arguments = parser.parse_args(argv)
    if not arguments.user_data:
        parser.error("--user-data is required")
    return ServiceOptions(
        user_data=Path(arguments.user_data),
        gateway_port=arguments.gateway_port,
        integration_test_mode=arguments.integration_test_mode,
        # An environment variable, not an argument: command lines are visible to every user.
        gateway_test_token=os.environ.get("HARDWAREHARNESS_GATEWAY_TEST_TOKEN"),
    )


async def serve(options: ServiceOptions) -> None:
    loop = asyncio.get_running_loop()
    closed = asyncio.Event()

    def watch_stdin() -> None:
        while sys.stdin.buffer.read(4096):
            pass
        loop.call_soon_threadsafe(closed.set)

    runtime = HostRuntime()
    try:
        await runtime.initialize(options)
        sys.stdout.write(json.dumps(runtime.handshake()) + "\n")
        sys.stdout.flush()
        threading.Thread(target=watch_stdin, name="stdin-watch", daemon=True).start()
        await closed.wait()
    finally:
        await runtime.close()


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    asyncio.run(serve(parse_options(argv)))


if __name__ == "__main__":
    main()
