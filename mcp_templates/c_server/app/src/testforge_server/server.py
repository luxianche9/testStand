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
def read_status(hardwareId: str) -> dict[str, Any]:
    return runtime.invoke(hardwareId, driver.read_status)


@mcp.tool(annotations=runtime.operate, meta={"testforge": {"kind": "hardware"}})
def set_output(hardwareId: str, value: float) -> dict[str, Any]:
    return runtime.invoke(hardwareId, lambda: driver.set_output(value))


prepare_shutdown = runtime.prepare_shutdown
create_app = runtime.create_app
main = runtime.main
