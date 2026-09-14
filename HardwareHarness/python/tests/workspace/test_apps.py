from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

from hardwareharness_backend.contracts.errors import AppError
from hardwareharness_backend.workspace import apps as apps_module
from hardwareharness_backend.workspace.apps import AppsService, PreviewGateway
from hardwareharness_backend.workspace.environment import EnvironmentManager


class InstalledEnvironment(EnvironmentManager):
    async def python(self, root_path: str) -> str:
        return sys.executable


def write_server(tmp_path: Path, text: str) -> None:
    (tmp_path / ".hardwareharness/apps/demo/server.py").write_text(text, encoding="utf-8")


def accept_localhost_cookie(client: httpx.AsyncClient) -> None:
    # http.cookiejar lacks Chromium's Secure-cookie exemption for trustworthy localhost.
    # The real Electron E2E verifies cookie delivery in the embedded browser itself.
    for cookie in client.cookies.jar:
        cookie.secure = False


class FakeRunner:
    def __init__(self) -> None:
        self.started: list[dict[str, Any]] = []
        self.cancelled: list[str] = []

    async def start_run(self, input: dict[str, Any]) -> dict[str, Any]:
        self.started.append(input)
        return {"runId": f"run-{len(self.started)}", "status": "running"}

    async def cancel_run(self, run_id: str) -> dict[str, Any]:
        self.cancelled.append(run_id)
        return {"runId": run_id, "status": "cancelled"}

    async def get_run(self, run_id: str) -> dict[str, Any]:
        return {"run": {"runId": run_id, "status": "succeeded"}, "events": []}

    async def run_events(
        self, run_id: str, after: int = 0, limit: int = 500
    ) -> list[dict[str, Any]]:
        return [{"sequence": 1, "kind": "run.completed"}] if after < 1 else []


def test_template_is_opt_in_and_never_overwrites(tmp_path: Path) -> None:
    service = AppsService(str(tmp_path), FakeRunner(), EnvironmentManager())
    assert service.list_apps() == []
    result = service.create_app("demo", "演示")
    assert result["id"] == "demo" and result["name"] == "演示"
    assert result["actions"][0]["hardwareIds"] == []
    root = tmp_path / ".hardwareharness"
    assert (root / "apps/demo/server.py").is_file()
    assert (root / "workflows/demo.py").is_file()
    assert "hardwareharness" not in (root / "apps/demo/server.py").read_text()
    with pytest.raises(AppError) as conflict:
        service.create_app("demo", "replacement")
    assert conflict.value.category == "conflict"


@pytest.mark.parametrize("app_id", ["../escape", "foo/bar", ".", "COM1", "a b"])
def test_app_ids_are_path_safe(tmp_path: Path, app_id: str) -> None:
    with pytest.raises(AppError):
        AppsService(str(tmp_path), FakeRunner(), EnvironmentManager()).create_app(app_id, "name")


async def test_each_action_creates_separate_run_with_hidden_hardware_declaration(
    tmp_path: Path,
) -> None:
    runner = FakeRunner()
    service = AppsService(str(tmp_path), runner, EnvironmentManager())
    service.create_app("demo", "Demo")
    first = await service.run_action("demo", "sample", {"samples": 2})
    second = await service.run_action("demo", "sample", {"samples": 3})
    assert first["runId"] != second["runId"]
    assert runner.started[0]["entrypoint"] == "workflows/demo.py"
    assert runner.started[0]["inputs"] == {"samples": 2}
    assert runner.started[0]["applicationId"] == "demo"
    assert runner.started[0]["actionId"] == "sample"
    with pytest.raises(AppError):
        await service.run_action("demo", "missing", {})


def test_manifest_rejects_path_escape_and_duplicate_actions(tmp_path: Path) -> None:
    service = AppsService(str(tmp_path), FakeRunner(), EnvironmentManager())
    service.create_app("demo", "Demo")
    path = tmp_path / ".hardwareharness/apps/demo/app.json"
    manifest = json.loads(path.read_text())
    manifest["actions"].append(manifest["actions"][0])
    path.write_text(json.dumps(manifest))
    with pytest.raises(AppError, match="Duplicate"):
        service.status("demo")
    manifest["actions"] = [manifest["actions"][0]]
    manifest["actions"][0]["entrypoint"] = "../bad.py"
    path.write_text(json.dumps(manifest))
    with pytest.raises(AppError):
        service.status("demo")


async def test_preview_requires_host_cookie_origin_and_scopes_run_access(tmp_path: Path) -> None:
    service = AppsService(str(tmp_path), FakeRunner(), EnvironmentManager())
    service.create_app("demo", "Demo")
    gateway = PreviewGateway(service, "demo", "http://127.0.0.1:8888", "token")
    service._states["demo"] = "running"
    gateway.authority = "127.0.0.1:9999"
    transport = httpx.ASGITransport(app=gateway.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:9999") as client:
        assert (await client.get("/")).status_code == 401
        assert (
            await client.get("/?ticket=token", headers={"host": "evil.test"})
        ).status_code == 403
        initial = await client.get("/?ticket=token")
        assert initial.status_code == 303 and "HttpOnly" in initial.headers["set-cookie"]
        assert "Secure" in initial.headers["set-cookie"]
        assert "Partitioned" in initial.headers["set-cookie"]
        accept_localhost_cookie(client)
        assert (await client.post("/__hardwareharness/actions/sample", json={})).status_code == 403
        response = await client.post(
            "/__hardwareharness/actions/sample",
            json={"samples": 2},
            headers={"origin": "http://127.0.0.1:9999"},
        )
        assert response.status_code == 200
        assert response.json()["runId"] == "run-1"
        assert (await client.get("/__hardwareharness/runs/another-run")).status_code == 404
        assert (await client.get("/__hardwareharness/runs/run-1")).status_code == 200
        events = await client.get("/__hardwareharness/runs/run-1/events")
        assert "run.completed" in events.text
        assert (
            await client.post(
                "/__hardwareharness/runs/run-1/cancel",
                headers={"origin": "http://evil.test"},
            )
        ).status_code == 403


async def test_stop_cancels_only_app_owned_runs(tmp_path: Path) -> None:
    runner = FakeRunner()
    service = AppsService(str(tmp_path), runner, EnvironmentManager())
    service.create_app("demo", "Demo")
    await service.run_action("demo", "sample", {})
    await service.stop("demo")
    assert runner.cancelled == ["run-1"]
    assert service.status("demo")["status"] == "stopped"


@pytest.mark.parametrize("count,after", [(0, 0), (500, 0), (501, 0), (1201, 0), (1201, 600)])
async def test_completed_preview_stream_drains_all_pages_on_reconnect(
    tmp_path: Path, count: int, after: int
) -> None:
    class PagedRunner(FakeRunner):
        async def get_run(self, run_id: str) -> dict[str, Any]:
            return {"run": {"runId": run_id, "status": "succeeded", "eventCount": count}}

        async def run_events(
            self, run_id: str, after: int = 0, limit: int = 500
        ) -> list[dict[str, Any]]:
            return [
                {"sequence": number} for number in range(after + 1, min(count, after + limit) + 1)
            ]

    service = AppsService(str(tmp_path), PagedRunner(), EnvironmentManager())
    gateway = PreviewGateway(service, "demo", "http://127.0.0.1:1", "ticket")
    try:
        records = [record async for record in gateway._events("run-1", after)]
    finally:
        await gateway.close()
    event_ids = [
        int(record.split("\n", 1)[0][4:]) for record in records if record.startswith("id:")
    ]
    assert event_ids == list(range(after + 1, count + 1))
    assert records[-1] == "event: complete\ndata: {}\n\n"


async def test_preview_stream_drains_events_persisted_during_terminal_status_read(
    tmp_path: Path,
) -> None:
    class FinishingRunner(FakeRunner):
        completed = False

        async def get_run(self, run_id: str) -> dict[str, Any]:
            self.completed = True
            return {"run": {"runId": run_id, "status": "succeeded", "eventCount": 1}}

        async def run_events(
            self, run_id: str, after: int = 0, limit: int = 500
        ) -> list[dict[str, Any]]:
            return [{"sequence": 1}] if self.completed and after == 0 else []

    service = AppsService(str(tmp_path), FinishingRunner(), EnvironmentManager())
    gateway = PreviewGateway(service, "demo", "http://127.0.0.1:1", "ticket")
    try:
        records = [record async for record in gateway._events("run-1", 0)]
    finally:
        await gateway.close()
    assert records == ['id: 1\ndata: {"sequence": 1}\n\n', "event: complete\ndata: {}\n\n"]


async def test_real_app_process_proxy_logs_and_shutdown(tmp_path: Path) -> None:
    service = AppsService(str(tmp_path), FakeRunner(), InstalledEnvironment())
    service.create_app("demo", "Demo")
    write_server(
        tmp_path,
        """from starlette.applications import Starlette
from starlette.responses import JSONResponse, RedirectResponse
from starlette.routing import Route
import os
print("中文服务器已启动", flush=True)
async def index(request):
    return JSONResponse({"ok": True, "workerCredential": os.environ.get("HH_TOKEN")})
async def redirect(request):
    return RedirectResponse("https://evil.example")
app = Starlette(routes=[Route("/", index), Route("/redirect", redirect)])
""",
    )
    assert service.logs("demo") == [] and not service.busy
    descriptor = await service.start("demo")
    try:
        assert service.busy and descriptor["status"] == "running"
        assert (await service.start("demo"))["previewUrl"] == descriptor["previewUrl"]
        async with httpx.AsyncClient(trust_env=False, follow_redirects=True) as client:
            initial = await client.get(descriptor["previewUrl"], follow_redirects=False)
            assert initial.status_code == 303
            accept_localhost_cookie(client)
            response = await client.get(str(initial.url).split("?")[0])
            assert response.json() == {"ok": True, "workerCredential": None}
            assert response.headers["x-content-type-options"] == "nosniff"
            assert (await client.get(str(response.url) + "redirect")).status_code == 403
        logs = service.logs("demo")
        assert any("中文服务器已启动" in item["text"] for item in logs)
        assert service.logs("demo", after=logs[-1]["sequence"]) == []
        assert service.list_apps()[0]["status"] == "running"
    finally:
        await service.close()
    assert not service.busy and not service._processes and not service._gateways


async def test_app_exits_unexpectedly_then_restart_and_failed_start(tmp_path: Path) -> None:
    service = AppsService(str(tmp_path), FakeRunner(), InstalledEnvironment())
    service.create_app("demo", "Demo")
    write_server(
        tmp_path,
        """from starlette.applications import Starlette
app = Starlette()
""",
    )
    await service.start("demo")
    await service.run_action("demo", "sample", {})
    service._processes["demo"].kill()
    for _ in range(100):
        if service.status("demo")["status"] == "failed":
            break
        await asyncio.sleep(0.02)
    assert service.status("demo")["status"] == "failed"
    await service.close()
    service = AppsService(str(tmp_path), FakeRunner(), InstalledEnvironment())
    write_server(tmp_path, "raise RuntimeError('server import failed')\n")
    with pytest.raises(AppError, match="exited"):
        await service.start("demo")
    assert service.status("demo")["status"] == "failed"
    assert not service._processes
    (tmp_path / ".hardwareharness/apps/demo/server.py").unlink()
    with pytest.raises(AppError, match="does not exist"):
        await service.start("demo")


@pytest.mark.parametrize(
    "value,message",
    [
        (None, "name"),
        ({"name": 12}, "name"),
        ({"name": "x", "server": "../bad.py:app", "actions": []}, "relative"),
        ({"name": "x", "server": "server.py", "actions": []}, "ASGI"),
        ({"name": "x"}, "actions"),
        ({"name": "x", "actions": [{}]}, "ID"),
        ({"name": "x", "actions": [{"id": "a", "entrypoint": "x.js"}]}, "Python"),
        (
            {
                "name": "x",
                "actions": [{"id": "a", "entrypoint": "x.py", "inputSchema": {"type": "bad"}}],
            },
            "schema",
        ),
        (
            {"name": "x", "actions": [{"id": "a", "entrypoint": "x.py", "hardwareIds": [1]}]},
            "hardwareIds",
        ),
    ],
)
def test_invalid_manifest_reports_actionable_validation(
    tmp_path: Path, value: Any, message: str
) -> None:
    service = AppsService(str(tmp_path), FakeRunner(), EnvironmentManager())
    service.create_app("demo", "Demo")
    (tmp_path / ".hardwareharness/apps/demo/app.json").write_text(json.dumps(value))
    with pytest.raises(AppError, match=message):
        service.status("demo")
    assert service.list_apps()[0]["status"] == "failed"


def test_missing_or_broken_manifest_and_empty_name(tmp_path: Path) -> None:
    service = AppsService(str(tmp_path), FakeRunner(), EnvironmentManager())
    with pytest.raises(AppError, match="name"):
        service.create_app("demo", " ")
    with pytest.raises(AppError, match="does not exist"):
        service.status("demo")
    service.create_app("demo", "Demo")
    (tmp_path / ".hardwareharness/apps/demo/app.json").write_bytes(b"broken{")
    with pytest.raises(AppError, match="JSON"):
        service.status("demo")
    (tmp_path / ".hardwareharness/apps/empty").mkdir()
    assert len(service.list_apps()) == 1


async def test_preview_api_errors_cancel_and_proxy_failure(tmp_path: Path) -> None:
    service = AppsService(str(tmp_path), FakeRunner(), EnvironmentManager())
    service.create_app("demo", "Demo")
    gateway = PreviewGateway(service, "demo", "http://127.0.0.1:1", "ticket")
    service._states["demo"] = "running"
    gateway.authority = "127.0.0.1:9999"
    transport = httpx.ASGITransport(app=gateway.app)
    headers = {"origin": "http://127.0.0.1:9999"}
    async with httpx.AsyncClient(transport=transport, base_url=headers["origin"]) as client:
        await client.get("/?ticket=ticket")
        accept_localhost_cookie(client)
        for body in (b"{bad", b"[]"):
            assert (
                await client.post(
                    "/__hardwareharness/actions/sample", content=body, headers=headers
                )
            ).status_code == 400
        assert (
            await client.post(
                "/__hardwareharness/actions/sample", json={"samples": -1}, headers=headers
            )
        ).status_code == 422
        assert (
            await client.post("/__hardwareharness/actions/sample", json={}, headers=headers)
        ).status_code == 200
        assert (await client.get("/__hardwareharness/missing")).status_code == 404
        assert (
            await client.get("/__hardwareharness/runs/run-1/events?after=bad")
        ).status_code == 400
        assert (
            await client.post("/__hardwareharness/runs/run-1/cancel", headers=headers)
        ).status_code == 200
        assert (await client.get("/")).status_code == 400
        assert (
            await client.post(
                "/__hardwareharness/actions/sample",
                content=b" " * (10 * 1024 * 1024 + 1),
                headers=headers,
            )
        ).status_code == 400
    await gateway.close()


async def test_close_during_environment_preparation_prevents_process_launch(tmp_path: Path) -> None:
    entered, release = asyncio.Event(), asyncio.Event()

    class WaitingEnvironment(EnvironmentManager):
        async def python(self, root_path: str) -> str:
            entered.set()
            await release.wait()
            return sys.executable

    service = AppsService(str(tmp_path), FakeRunner(), WaitingEnvironment())
    service.create_app("demo", "Demo")
    starting = asyncio.create_task(service.start("demo"))
    await entered.wait()
    closing = asyncio.create_task(service.close())
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(AppError, match="closed"):
        await starting
    await closing
    assert not service._processes
    with pytest.raises(AppError, match="closed"):
        await service.start("demo")
    with pytest.raises(AppError, match="closed"):
        await service.run_action("demo", "sample", {})


async def test_stopped_preview_cannot_launch_a_new_action(tmp_path: Path) -> None:
    service = AppsService(str(tmp_path), FakeRunner(), EnvironmentManager())
    service.create_app("demo", "Demo")
    with pytest.raises(AppError, match="stopped"):
        await service.run_action("demo", "sample", {}, require_running=True)


async def test_preview_start_failure_closes_listener_client_and_app_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = AppsService(str(tmp_path), FakeRunner(), InstalledEnvironment())
    service.create_app("demo", "Demo")
    write_server(tmp_path, "from starlette.applications import Starlette\napp = Starlette()\n")
    instances: list[PreviewGateway] = []

    class FailingGateway(PreviewGateway):
        async def start(self) -> None:
            instances.append(self)
            await super().start()
            raise AppError("unavailable", "preview failed after socket binding")

    monkeypatch.setattr(apps_module, "PreviewGateway", FailingGateway)
    with pytest.raises(AppError, match="socket binding"):
        await service.start("demo")
    assert instances[0]._listener is not None
    assert instances[0]._listener.fileno() == -1
    assert instances[0]._client.is_closed
    assert not service._processes and not service._gateways


async def test_output_disk_failure_stops_app_and_owned_runs(tmp_path: Path) -> None:
    class UnwritableLogs(AppsService):
        async def _capture_output(
            self, app_id: str, stream: asyncio.StreamReader | None, name: str
        ) -> None:
            raise OSError("disk full")

    runner = FakeRunner()
    service = UnwritableLogs(str(tmp_path), runner, InstalledEnvironment())
    service.create_app("demo", "Demo")
    await service.run_action("demo", "sample", {})
    write_server(tmp_path, "from starlette.applications import Starlette\napp = Starlette()\n")
    with pytest.raises(AppError, match="recorded"):
        await service.start("demo")
    await service.close()
    assert runner.cancelled == ["run-1"]
    assert not service._processes and not service._gateways
    assert "disk full" in service.status("demo")["error"]


async def test_preview_close_releases_resources_after_server_task_failure(tmp_path: Path) -> None:
    service = AppsService(str(tmp_path), FakeRunner(), EnvironmentManager())
    gateway = PreviewGateway(service, "demo", "http://127.0.0.1:1", "ticket")

    async def failed_server() -> None:
        raise OSError("server startup failed")

    gateway._task = asyncio.create_task(failed_server())
    gateway._listener = apps_module._socket()
    await gateway.close()
    assert gateway._client.is_closed and gateway._listener.fileno() == -1


async def test_logging_failure_after_start_stops_service_proactively(tmp_path: Path) -> None:
    fail = asyncio.Event()

    class FailingAfterStartup(AppsService):
        async def _capture_output(
            self, app_id: str, stream: asyncio.StreamReader | None, name: str
        ) -> None:
            await fail.wait()
            raise OSError("disk became unwritable")

    runner = FakeRunner()
    service = FailingAfterStartup(str(tmp_path), runner, InstalledEnvironment())
    service.create_app("demo", "Demo")
    write_server(tmp_path, "from starlette.applications import Starlette\napp = Starlette()\n")
    await service.start("demo")
    await service.run_action("demo", "sample", {})
    fail.set()
    async with asyncio.timeout(5):
        while (
            service._processes or service._gateways or service.status("demo")["status"] != "failed"
        ):
            await asyncio.sleep(0.02)
    assert service.status("demo")["status"] == "failed"
    assert runner.cancelled == ["run-1"]
    await service.close()
