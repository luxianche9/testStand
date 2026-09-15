"""Exercise the shipped runtime with a fresh offline project and no machine Python on PATH."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from hardwareharness_backend.automation.service import AutomationService
from hardwareharness_backend.workspace.environment import EnvironmentManager


async def smoke(runtime: Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="HardwareHarness 中文 offline ") as temporary:
        project = Path(temporary)
        environment = EnvironmentManager(resources=runtime.resolve(), frozen=True)

        async def interpreter() -> str:
            return await environment.python(str(project))

        runner = AutomationService(lambda: str(project), python_provider=interpreter)
        old_env = os.environ.copy()
        os.environ.update(
            PATH=str(Path(os.environ.get("SYSTEMROOT", "C:/Windows")) / "System32"),
            UV_OFFLINE="1",
            UV_CACHE_DIR=str(project / "empty-cache"),
            UV_PYTHON_DOWNLOADS="never",
            PYTHONUTF8="1",
        )
        try:
            info = await environment.prepare(str(project))
            assert info["status"] == "ready", info
            script = project / ".hardwareharness/scripts/sample.py"
            script.write_text(
                "from hardwareharness import measurement, step\n\n"
                "def main(inputs):\n"
                "    with step('offline smoke'):\n"
                "        measurement('value', inputs['value'], unit='count')\n"
                "    return {'value': inputs['value']}\n",
                encoding="utf-8",
                newline="\n",
            )
            started = await runner.start_run(
                {
                    "entrypoint": "scripts/sample.py",
                    "name": "Offline Python program",
                    "inputs": {"value": 2},
                    "hardwareIds": [],
                }
            )
            async with asyncio.timeout(30):
                while True:
                    detail = await runner.get_run(started["runId"])
                    if detail["run"]["status"] not in {"running", "cancelling"}:
                        break
                    await asyncio.sleep(0.05)
            assert detail["run"]["status"] == "succeeded", detail
            assert any(event["type"] == "measurement" for event in detail["events"]), detail
            return {
                "status": "passed",
                "runtime": str(runtime.resolve()),
                "projectPathContainsChineseAndSpaces": True,
                "systemPythonAndUvRemovedFromPath": True,
                "uvOffline": True,
                "freshCache": True,
                "runStatus": detail["run"]["status"],
                "events": len(detail["events"]),
                "measurementRecorded": True,
                "webApplicationServiceAbsent": True,
                "independentCleanWindowsVerified": False,
                "physicalNetworkDisconnected": False,
            }
        finally:
            await runner.close()
            assert not runner.active
            os.environ.clear()
            os.environ.update(old_env)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--report", type=Path)
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    result = asyncio.run(smoke(arguments.runtime or root / "dist/project-runtime-v1"))
    result["processCleanupVerified"] = True
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if arguments.report:
        arguments.report.parent.mkdir(parents=True, exist_ok=True)
        arguments.report.write_text(rendered, encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
