from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from testforge_sim_hardware.config import load_config
from testforge_sim_hardware.drivers import AnalogInputDriver, AnalogOutputDriver, SerialDriver, create_driver
from testforge_sim_hardware.runtime import TestForgeSimRuntime

HARDWARE_META = {"testforge": {"kind": "hardware"}}


def build_runtime(config_path: str | None = None) -> TestForgeSimRuntime:
    config = load_config(config_path)
    driver = create_driver(config)
    runtime = TestForgeSimRuntime(config, driver)

    if isinstance(driver, AnalogInputDriver):
        @runtime.mcp.tool(annotations=runtime.hardware_read, meta=HARDWARE_META)
        def read_analog_input(hardwareId: str, channel: int) -> dict[str, Any]:
            return runtime.invoke(hardwareId, lambda: driver.read(channel))

        @runtime.mcp.tool(annotations=runtime.hardware_read, meta=HARDWARE_META)
        def read_all_analog_inputs(hardwareId: str) -> dict[str, Any]:
            return runtime.invoke(hardwareId, driver.read_all)

    elif isinstance(driver, AnalogOutputDriver):
        @runtime.mcp.tool(annotations=runtime.hardware_write, meta=HARDWARE_META)
        def write_analog_output(hardwareId: str, channel: int, voltage: float) -> dict[str, Any]:
            return runtime.invoke(hardwareId, lambda: driver.write(channel, voltage))

        @runtime.mcp.tool(annotations=runtime.hardware_write, meta=HARDWARE_META)
        def write_all_analog_outputs(hardwareId: str, voltages: list[float]) -> dict[str, Any]:
            return runtime.invoke(hardwareId, lambda: driver.write_all(voltages))

    elif isinstance(driver, SerialDriver):
        @runtime.mcp.tool(annotations=runtime.hardware_write, meta=HARDWARE_META)
        def write_serial(hardwareId: str, port: int, data: str) -> dict[str, Any]:
            return runtime.invoke(hardwareId, lambda: driver.write(port, data))

        @runtime.mcp.tool(annotations=runtime.hardware_read, meta=HARDWARE_META)
        def read_serial(hardwareId: str, port: int) -> dict[str, Any]:
            return runtime.invoke(hardwareId, lambda: driver.read(port))

    return runtime


def main() -> None:
    _redirect_process_output()
    build_runtime().main()


def _redirect_process_output() -> None:
    for attribute, environment_name in (("stdout", "TESTFORGE_SIM_STDOUT"), ("stderr", "TESTFORGE_SIM_STDERR")):
        target = os.environ.get(environment_name)
        if not target:
            continue
        path = Path(target)
        path.parent.mkdir(parents=True, exist_ok=True)
        setattr(sys, attribute, path.open("a", encoding="utf-8", buffering=1))
