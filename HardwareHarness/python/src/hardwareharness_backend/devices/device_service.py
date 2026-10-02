from __future__ import annotations

import asyncio
import logging
from typing import Any

from hardwareharness_backend.contracts.devices import parse_mcp_server, parse_remote_computer
from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.util import json_loads, now_ms, utc_now_iso

from .device_manifest import asset_paths, declared_streams
from .lifecycle import is_managed, lifecycle_command
from .local_shell import execute_local_shell
from .remote_shell import remote_shell_for
from .service_registry import parse_registry, read_registry_script, read_token_script
from .ssh import SshManager

Record = dict[str, Any]

log = logging.getLogger(__name__)


class DeviceService:
    def __init__(self, store: Any, secrets: Any, transports: Any) -> None:
        self.store, self.secrets, self.transports = store, secrets, transports
        self.ssh: Any = SshManager(secrets)
        self._computer_refreshes: dict[str, asyncio.Task[Record]] = {}
        self._server_refreshes: dict[str, asyncio.Task[Record]] = {}
        self._statuses: dict[str, Record] = {}
        self._server_statuses: dict[str, Record] = {}
        self._hardware: list[Record] = []
        self._availability: dict[str, Record] = {}
        self._streams: dict[str, list[Record]] = {}

    def list_computers(self) -> list[Record]:
        return list(self.store.list_computers())

    def list_statuses(self) -> list[Record]:
        return list(self._statuses.values())

    def list_servers(self) -> list[Record]:
        return list(self.store.list_servers())

    def list_server_statuses(self) -> list[Record]:
        return list(self._server_statuses.values())

    def list_hardware(self) -> list[Record]:
        return self._hardware

    def list_availability(self) -> list[Record]:
        return list(self._availability.values())

    def list_tools(self) -> list[Record]:
        return list(self.transports.list_tools())

    async def call_tool(self, name: str, args: Record, options: Record | None = None) -> Any:
        return await self.call_aggregated_tool(name, args, options)

    async def save_computer(self, value: Record, credentials: Record | None = None) -> Record:
        computer = parse_remote_computer(value)
        if credentials and "ssh" in credentials:
            credential = credentials["ssh"]
            await self.secrets.set(
                f"ssh:{computer['id']}",
                {"kind": "password", "password": credential}
                if isinstance(credential, str)
                else credential,
            )
        await self.ssh.disconnect(computer["id"])
        return dict(await self.store.save_computer(computer))

    async def remove_computer(self, computer_id: str) -> None:
        for server in self.store.list_servers():
            if server.get("computerId") != computer_id:
                continue
            await self.transports.disconnect(server["serverId"])
            await self.secrets.remove(f"mcp:{server['serverId']}")
            self._server_statuses.pop(server["serverId"], None)
            self._hardware = [
                item for item in self._hardware if item["serverId"] != server["serverId"]
            ]
        await self.ssh.disconnect(computer_id)
        await self.store.remove_computer(computer_id)
        await self.secrets.remove(f"ssh:{computer_id}")
        self._statuses.pop(computer_id, None)

    async def save_server(self, value: Record, credentials: Record | None = None) -> Record:
        server = parse_mcp_server(value)
        if "computerId" in server:
            self._require_computer(server["computerId"])
        if credentials and "mcpToken" in credentials:
            await self.secrets.set(f"mcp:{server['serverId']}", {"token": credentials["mcpToken"]})
        saved = await self.store.save_server(server)
        await self.transports.disconnect(server["serverId"])
        return dict(saved)

    async def remove_server(self, server_id: str) -> None:
        self._require_server(server_id)
        await self.transports.disconnect(server_id)
        await self.store.remove_server(server_id)
        await self.secrets.remove(f"mcp:{server_id}")
        self._server_statuses.pop(server_id, None)
        self._hardware = [item for item in self._hardware if item["serverId"] != server_id]

    def _require_computer(self, computer_id: str) -> Record:
        computer = self.store.get_computer(computer_id)
        if not computer:
            raise RuntimeError(f"Remote computer not found: {computer_id}")
        return dict(computer)

    def _require_server(self, server_id: str) -> Record:
        server = self.store.get_server(server_id)
        if not server:
            raise RuntimeError(f"MCP server not found: {server_id}")
        return dict(server)

    async def execute(self, computer_id: str, command: str, timeout_ms: int = 60000) -> Record:
        computer = self._require_computer(computer_id)
        if computer.get("execution") == "local":
            return await execute_local_shell(
                computer["ssh"]["shell"], command, min(max(timeout_ms, 1000), 300000)
            )
        return dict(
            await self.ssh.execute(
                computer,
                remote_shell_for(computer).command(command),
                min(max(timeout_ms, 1000), 300000),
            )
        )

    async def refresh_computer(self, computer_id: str) -> Record:
        pending = self._computer_refreshes.get(computer_id)
        if pending is None:
            pending = asyncio.create_task(self._refresh_computer(computer_id))
            self._computer_refreshes[computer_id] = pending
            pending.add_done_callback(lambda _: self._computer_refreshes.pop(computer_id, None))
        return await asyncio.shield(pending)

    async def _refresh_computer(self, computer_id: str) -> Record:
        computer = self._require_computer(computer_id)
        started = now_ms()
        status: Record = {"computerId": computer_id, "ssh": {"state": "checking"}}
        self._statuses.setdefault(computer_id, dict(status))
        try:
            shell = remote_shell_for(computer)
            result = await self.execute(computer_id, shell.probe_command(), 15000)
            if result["exitCode"] != 0:
                raise RuntimeError(result["stderr"] or "Computer shell probe failed")
            status["ssh"] = {
                "state": "online",
                "checkedAt": utc_now_iso(),
                "latencyMs": now_ms() - started,
            }
        except Exception as error:
            status["ssh"] = {
                "state": "offline",
                "checkedAt": utc_now_iso(),
                "message": str(error),
            }
        self._statuses[computer_id] = status
        return status

    async def refresh_server(self, server_id: str) -> Record:
        pending = self._server_refreshes.get(server_id)
        if pending is None:
            pending = asyncio.create_task(self._refresh_server(server_id))
            self._server_refreshes[server_id] = pending
            pending.add_done_callback(lambda _: self._server_refreshes.pop(server_id, None))
        return await asyncio.shield(pending)

    async def _refresh_server(self, server_id: str) -> Record:
        stored = self.store.get_server(server_id)
        status: Record = {
            "serverId": server_id,
            "computerId": (stored or {}).get("computerId", ""),
            "service": {"state": "checking", "serviceState": "unknown"},
            "transport": {"state": "checking"},
        }
        self._server_statuses.setdefault(server_id, dict(status))
        try:
            server = self._require_server(server_id)
            if "computerId" in server:
                self._require_computer(server["computerId"])
        except Exception as error:
            status["service"] = {
                "state": "error",
                "checkedAt": utc_now_iso(),
                "serviceState": "unknown",
                "message": str(error),
            }
            status["transport"] = {
                "state": "error",
                "checkedAt": utc_now_iso(),
                "message": str(error),
            }
            self._server_statuses[server_id] = status
            return status
        try:
            session = await self.transports.connect(server)
            hardware = session.get("hardware")
            if hardware:
                self._hardware = [item for item in self._hardware if item["serverId"] != server_id]
                self._hardware.append(hardware)
            status["transport"] = {"state": "online", "checkedAt": utc_now_iso()}
            status["service"] = {
                "state": "unknown",
                "checkedAt": utc_now_iso(),
                "serviceState": "unknown",
                "message": "Not queried: device transport is available",
            }
            hardware_id = hardware["hardwareId"] if hardware else server["hardwareId"]
            await self._sync_definition(server, hardware_id)
            last_error = (hardware or {}).get("lastError") or {}
            self._availability[hardware_id] = {
                "hardwareId": hardware_id,
                "state": "faulted"
                if hardware and hardware.get("state") == "faulted"
                else "available",
                "checkedAt": utc_now_iso(),
                **({"message": last_error["message"]} if last_error.get("message") else {}),
            }
        except Exception as error:
            status["transport"] = {
                "state": "offline",
                "checkedAt": utc_now_iso(),
                "message": str(error),
            }
            try:
                if not is_managed(server):
                    raise RuntimeError("Unmanaged service: no computer to query the process on")
                service = await self.execute(
                    server["computerId"], lifecycle_command(server, "statusCommand"), 15000
                )
                parsed = json_loads(service["stdout"].strip() or "{}")
                state = _normalize_service_state(parsed.get("state"))
                message = parsed.get("message", parsed.get("state", "Unknown"))
                status["service"] = {
                    "state": "online" if state == "running" else "offline",
                    "checkedAt": utc_now_iso(),
                    "serviceState": state,
                    "message": message,
                }
                process_message = parsed.get("message", parsed.get("state"))
                self._availability[server["hardwareId"]] = {
                    "hardwareId": server["hardwareId"],
                    "state": "faulted" if state == "running" else "unavailable",
                    "checkedAt": utc_now_iso(),
                    "message": str(error),
                    "diagnostics": {
                        "transport": str(error),
                        **({"process": process_message} if process_message else {}),
                    },
                }
            except Exception as diagnostic_error:
                status["service"] = {
                    "state": "unknown",
                    "checkedAt": utc_now_iso(),
                    "serviceState": "unknown",
                    "message": str(diagnostic_error),
                }
                self._availability[server["hardwareId"]] = {
                    "hardwareId": server["hardwareId"],
                    "state": "unavailable",
                    "checkedAt": utc_now_iso(),
                    "message": str(error),
                    "diagnostics": {
                        "transport": str(error),
                        "ssh": str(diagnostic_error),
                    },
                }
        self._server_statuses[server_id] = status
        return status

    async def _sync_definition(self, server: Record, hardware_id: str) -> None:
        """Cache the service's ``/device`` (and its assets) when its revision changed."""
        try:
            document = await self.transports.describe_device(server)
            if not isinstance(document, dict):
                return
            self._streams[hardware_id] = declared_streams(document)
            cached = self.store.get_definition(hardware_id)
            revision = document.get("manifestRevision")
            paths = asset_paths(document)
            if (
                cached is not None
                and cached["document"].get("manifestRevision") == revision
                and all(
                    self.store.image_path(
                        hardware_id, self.store.definition_asset_id(path)
                    ).is_file()
                    for path in paths
                )
            ):
                return
            assets: dict[str, bytes] = {}
            for path in paths:
                try:
                    assets[path] = await self.transports.read_asset(server, path)
                except Exception as error:
                    log.warning("Asset %s of %s is unavailable: %s", path, hardware_id, error)
            await self.store.save_definition(hardware_id, document, assets)
        except Exception as error:
            log.warning("Could not refresh the declaration of %s: %s", hardware_id, error)

    def get_definition(self, hardware_id: str) -> Record | None:
        """The managed device's declaration as last cached, read-only (design doc §9.7).

        ``offline`` says the service is not reachable now, so this is the cached version.
        Image entries carry the ``assetId`` of their cached file.
        """
        cached = self.store.get_definition(hardware_id)
        if cached is None:
            return None
        document = cached["document"]
        images = document.get("images")
        appearance = images.get("appearance") if isinstance(images, dict) else None
        self._attach_asset_id(appearance)
        pinout = document.get("pinout")
        connectors = pinout.get("connectors") if isinstance(pinout, dict) else None
        for connector in connectors if isinstance(connectors, list) else []:
            if isinstance(connector, dict):
                self._attach_asset_id(connector.get("image"))
        server = next(
            (item for item in self.store.list_servers() if item["hardwareId"] == hardware_id),
            None,
        )
        status = self._server_statuses.get(server["serverId"]) if server else None
        online = bool(status and status.get("transport", {}).get("state") == "online")
        return {
            "hardwareId": hardware_id,
            "manifestRevision": document.get("manifestRevision"),
            "fetchedAt": cached.get("fetchedAt"),
            "offline": not online,
            "document": document,
        }

    def _attach_asset_id(self, image: Any) -> None:
        if isinstance(image, dict) and isinstance(image.get("asset"), str):
            image["assetId"] = self.store.definition_asset_id(image["asset"])

    async def refresh_all_servers(self) -> list[Record]:
        results = await asyncio.gather(
            *(self.refresh_server(server["serverId"]) for server in self.store.list_servers()),
            return_exceptions=True,
        )
        return [result for result in results if not isinstance(result, BaseException)]

    async def server_action(self, server_id: str, action: str) -> Record:
        server = self._require_server(server_id)
        command = lifecycle_command(
            server,
            {"stop": "stopCommand", "force-stop": "forceStopCommand"}.get(action, "startCommand"),
        )
        if action not in {"start", "force-stop"}:
            try:
                await self.transports.connect(server)
                await self.transports.prepare_shutdown(server)
            except Exception as error:
                raise app_error(
                    "safe_stop_failed",
                    f"Safe-stop failed; {server_id} was left running. "
                    "Use force-stop only after assessing the physical risk.",
                    {"cause": error},
                ) from error
        if action == "restart":
            stopped = await self.execute(
                server["computerId"], lifecycle_command(server, "stopCommand"), 90000
            )
            if stopped["exitCode"] != 0:
                raise RuntimeError(stopped["stderr"] or "Remote MCP stop command failed")
            await self.transports.disconnect(server_id)
        result = await self.execute(server["computerId"], command, 90000)
        if result["exitCode"] != 0:
            raise RuntimeError(result["stderr"] or f"Remote MCP {action} command failed")
        if action in {"stop", "force-stop"}:
            await self.transports.disconnect(server_id)
        else:
            last_error: Exception | None = None
            for _ in range(20):
                try:
                    await self.transports.connect(server)
                    last_error = None
                    break
                except Exception as error:
                    last_error = error
                    await asyncio.sleep(1)
            if last_error:
                raise last_error
        return await self.refresh_server(server_id)

    async def read_server_logs(self, server_id: str, lines: int = 200) -> Record:
        server = self._require_server(server_id)
        log_path = lifecycle_command(server, "logPath")
        computer = self._require_computer(server["computerId"])
        command = remote_shell_for(computer).read_logs_command(log_path, min(max(lines, 1), 2000))
        result = await self.execute(server["computerId"], command, 15000)
        return {
            "lines": [
                line.removesuffix("\r")
                for line in result["stdout"].split("\n")
                if line.removesuffix("\r")
            ],
            "truncated": result["truncated"],
            "path": log_path,
        }

    def require_powershell(self, computer_id: str) -> Record:
        computer = self._require_computer(computer_id)
        if computer["ssh"]["shell"] != "powershell":
            raise app_error(
                "invalid_argument",
                f"{computer_id}: services are only installed on Windows (PowerShell) computers",
            )
        return computer

    async def discover_services(self, computer_id: str) -> list[Record]:
        """Installed services from the computer's ``services.json``, marked if already added."""
        computer = self.require_powershell(computer_id)
        result = await self.execute(computer_id, read_registry_script(), 15000)
        if result["exitCode"] != 0:
            raise RuntimeError(result["stderr"] or "Reading services.json failed")
        known = {server["serverId"]: server for server in self.list_servers()}
        return [
            {
                **entry,
                "url": f"http://{computer['address']}:{entry['port']}/mcp",
                "added": entry["serverId"] in known,
            }
            for entry in parse_registry(result["stdout"])
        ]

    async def read_service_token(self, computer_id: str, root: str) -> str:
        """The token in ``<root>\\server.json``; returned to the caller, never logged."""
        self.require_powershell(computer_id)
        result = await self.execute(computer_id, read_token_script(root), 15000)
        token = result["stdout"].strip()
        if result["exitCode"] != 0 or not token:
            raise app_error("not_found", f"No token in {root}\\server.json")
        return str(token)

    async def refresh_hardware(self) -> list[Record]:
        self._hardware = await self.transports.list_hardware(self.store.list_servers())
        return self._hardware

    async def call_aggregated_tool(
        self, external_name: str, args: Record, options: Record | None = None
    ) -> Any:
        tool = next(
            (item for item in self.list_tools() if item["externalName"] == external_name), None
        )
        if not tool:
            raise RuntimeError(f"Unknown aggregated tool: {external_name}")
        server = self._require_server(tool["serverId"])
        options = options or {}
        return await self.transports.call_tool(
            external_name,
            args,
            {
                **options,
                "metadata": {
                    **options.get("metadata", {}),
                    "hardwareId": server["hardwareId"],
                },
            },
        )

    def server_for(self, hardware_id: str) -> Record:
        """The enabled service that owns ``hardware_id`` (one service, one hardware)."""
        server = next(
            (
                item
                for item in self.store.list_servers()
                if item["hardwareId"] == hardware_id and item["enabled"]
            ),
            None,
        )
        if server is None:
            raise app_error("not_found", f"No enabled MCP server for hardware {hardware_id}")
        return dict(server)

    async def list_streams(self, hardware_id: str) -> list[Record]:
        """``[{id, type}]`` as the hardware's service declares them."""
        streams = list(await self.transports.list_streams(self.server_for(hardware_id)))
        self._streams[hardware_id] = streams
        return streams

    def known_streams(self, hardware_id: str) -> list[Record] | None:
        """Streams last listed or cached from ``/device`` for this hardware (``None``: unknown)."""
        streams = self._streams.get(hardware_id)
        if streams is None:
            cached = self.store.get_definition(hardware_id)
            if cached is not None:
                streams = declared_streams(cached["document"])
        return list(streams) if streams is not None else None

    async def call_management(self, hardware_id: str, name: str, args: Record) -> Any:
        """Unprefixed SDK management tools (``lease_acquire``, ``lease_status`` ...)."""
        server = self.server_for(hardware_id)
        return await self.transports.call_internal(
            server, name, {"hardwareId": hardware_id, **args}
        )

    async def read_blob(self, hardware_id: str, stream_id: str, ref: str) -> Record:
        return dict(await self.transports.read_blob(self.server_for(hardware_id), stream_id, ref))

    async def close(self) -> None:
        await self.ssh.close()


def _normalize_service_state(value: str | None) -> str:
    lowered = (value or "").strip().lower()
    if lowered in {"running", "stopped"}:
        return lowered
    return {
        "startpending": "starting",
        "starting": "starting",
        "stoppending": "stopping",
        "stopping": "stopping",
    }.get(lowered, "unknown")
