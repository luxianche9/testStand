"""Exercise the shipped runtime with a fresh offline project and no machine Python on PATH."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import httpx

from hardwareharness_backend.automation.service import AutomationService
from hardwareharness_backend.workspace.apps import AppsService
from hardwareharness_backend.workspace.environment import EnvironmentManager


async def smoke(runtime: Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="HardwareHarness 中文 offline ") as temporary:
        project = Path(temporary)
        environment = EnvironmentManager(resources=runtime.resolve(), frozen=True)

        async def interpreter() -> str:
            return await environment.python(str(project))

        runner = AutomationService(lambda: str(project), python_provider=interpreter)
        apps = AppsService(str(project), runner, environment)
        apps.create_app("sample", "Offline sample")
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
            application = await apps.start("sample")
            async with httpx.AsyncClient(trust_env=False, follow_redirects=True) as client:
                initial = await client.get(application["previewUrl"], follow_redirects=False)
                assert initial.status_code == 303
                # cookiejar lacks Chromium's localhost exemption for Secure cookies.
                # Electron E2E independently exercises real browser cookie delivery.
                for cookie in client.cookies.jar:
                    cookie.secure = False
                page = await client.get(str(initial.url).split("?")[0])
                assert page.status_code == 200 and "HardwareHarness" in page.text
                origin = str(page.url).rstrip("/")
                response = await client.post(
                    origin + "/__hardwareharness/actions/sample",
                    json={"samples": 2},
                    headers={"origin": origin},
                )
                response.raise_for_status()
                run_id = response.json()["runId"]
                async with asyncio.timeout(30):
                    while True:
                        detail = await runner.get_run(run_id)
                        if detail["run"]["status"] not in {"running", "cancelling"}:
                            break
                        await asyncio.sleep(0.05)
                assert detail["run"]["status"] == "succeeded", detail
                assert len(detail["events"]) >= 5, detail
            return {
                "status": "passed",
                "runtime": str(runtime.resolve()),
                "projectPathContainsChineseAndSpaces": True,
                "systemPythonAndUvRemovedFromPath": True,
                "uvOffline": True,
                "freshCache": True,
                "previewHttpStatus": page.status_code,
                "runStatus": detail["run"]["status"],
                "events": len(detail["events"]),
                "independentCleanWindowsVerified": False,
                "physicalNetworkDisconnected": False,
            }
        finally:
            await apps.close()
            await runner.close()
            assert not apps._processes and not runner.active
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
