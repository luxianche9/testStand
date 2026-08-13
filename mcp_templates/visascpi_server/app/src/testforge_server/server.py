from __future__ import annotations

from typing import Any

from testforge_runtime.config import load_config
from testforge_runtime.server import TestForgeServerRuntime
from testforge_server import __version__
from testforge_server.hardware import HardwareDriver

config = load_config()
driver = HardwareDriver(config)
runtime = TestForgeServerRuntime(config, driver, __version__)
mcp = runtime.mcp


@mcp.tool(annotations=runtime.operate, meta={"testforge": {"kind": "hardware"}})
def scpi_write(hardwareId: str, command: str) -> dict[str, Any]:
    return runtime.invoke(hardwareId, lambda: driver.write(command))


@mcp.tool(annotations=runtime.describe, meta={"testforge": {"kind": "hardware"}})
def scpi_query(hardwareId: str, command: str) -> dict[str, Any]:
    return runtime.invoke(hardwareId, lambda: driver.query(command))


@mcp.tool(annotations=runtime.describe, meta={"testforge": {"kind": "hardware"}})
def scpi_query_binary(hardwareId: str, command: str, datatype: str = "B", maxBytes: int = 1_048_576) -> dict[str, Any]:
    return runtime.invoke(hardwareId, lambda: driver.query_binary(command, datatype, maxBytes))


prepare_shutdown = runtime.prepare_shutdown
create_app = runtime.create_app
main = runtime.main
