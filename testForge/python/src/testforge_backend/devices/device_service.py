from __future__ import annotations

import asyncio
from typing import Any

from testforge_backend.compat import js_string, json_parse, now_ms, utc_now_iso
from testforge_backend.contracts.devices import parse_mcp_server, parse_remote_computer
from testforge_backend.contracts.errors import app_error

from .hardware_occupancy import HardwareOccupancyManager
from .local_shell import execute_local_shell
from .remote_shell import remote_shell_for
from .ssh import SshManager

Record = dict[str, Any]


class DeviceService:
    def __init__(self, store: Any, secrets: Any, transports: Any) -> None:
        self.store, self.secrets, self.transports = store, secrets, transports
        self.ssh: Any = SshManager(secrets)
        self.occupancy = HardwareOccupancyManager(store, transports)
        self._computer_refreshes: dict[str, asyncio.Task[Record]] = {}
        self._server_refreshes: dict[str, asyncio.Task[Record]] = {}
        self._statuses: dict[str, Record] = {}
        self._server_statuses: dict[str, Record] = {}
        self._hardware: list[Record] = []
        self._availability: dict[str, Record] = {}

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

    def is_hardware_occupied(self, hardware_id: str) -> bool:
        return self.occupancy.is_held(hardware_id)

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
            if server["computerId"] != computer_id:
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
                "message": js_string(error),
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
            "computerId": stored["computerId"] if stored else "",
            "service": {"state": "checking", "serviceState": "unknown"},
            "transport": {"state": "checking"},
        }
        self._server_statuses.setdefault(server_id, dict(status))
        try:
            server = self._require_server(server_id)
            self._require_computer(server["computerId"])
        except Exception as error:
            status["service"] = {
                "state": "error",
                "checkedAt": utc_now_iso(),
                "serviceState": "unknown",
                "message": js_string(error),
            }
            status["transport"] = {
                "state": "error",
                "checkedAt": utc_now_iso(),
                "message": js_string(error),
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
            last_error = (hardware or {}).get("lastError") or {}
            self._availability[hardware_id] = {
                "hardwareId": hardware_id,
                "state": "faulted"
                if hardware and hardware.get("state") == "faulted"
                else "available",
                "checkedAt": utc_now_iso(),
                **({"message": last_error["message"]} if last_error.get("message") else {}),
            }
            await self.occupancy.refresh(hardware_id)
        except Exception as error:
            status["transport"] = {
                "state": "offline",
                "checkedAt": utc_now_iso(),
                "message": js_string(error),
            }
            try:
                service = await self.execute(
                    server["computerId"], server["lifecycle"]["statusCommand"], 15000
                )
                parsed = json_parse(service["stdout"].strip() or "{}")
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
                    "message": js_string(error),
                    "diagnostics": {
                        "transport": js_string(error),
                        **({"process": process_message} if process_message else {}),
                    },
                }
            except Exception as diagnostic_error:
                status["service"] = {
                    "state": "unknown",
                    "checkedAt": utc_now_iso(),
                    "serviceState": "unknown",
                    "message": js_string(diagnostic_error),
                }
                self._availability[server["hardwareId"]] = {
                    "hardwareId": server["hardwareId"],
                    "state": "unavailable",
                    "checkedAt": utc_now_iso(),
                    "message": js_string(error),
                    "diagnostics": {
                        "transport": js_string(error),
                        "ssh": js_string(diagnostic_error),
                    },
                }
        self._server_statuses[server_id] = status
        return status

    async def refresh_all_servers(self) -> list[Record]:
        results = await asyncio.gather(
            *(self.refresh_server(server["serverId"]) for server in self.store.list_servers()),
            return_exceptions=True,
        )
        return [result for result in results if not isinstance(result, BaseException)]

    async def server_action(self, server_id: str, action: str) -> Record:
        server = self._require_server(server_id)
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
                server["computerId"], server["lifecycle"]["stopCommand"], 90000
            )
            if stopped["exitCode"] != 0:
                raise RuntimeError(stopped["stderr"] or "Remote MCP stop command failed")
            await self.transports.disconnect(server_id)
        command = server["lifecycle"][
            "stopCommand" if action in {"stop", "force-stop"} else "startCommand"
        ]
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
        computer = self._require_computer(server["computerId"])
        command = remote_shell_for(computer).read_logs_command(
            server["lifecycle"]["logPath"], min(max(lines, 1), 2000)
        )
        result = await self.execute(server["computerId"], command, 15000)
        return {
            "lines": [
                line.removesuffix("\r")
                for line in result["stdout"].split("\n")
                if line.removesuffix("\r")
            ],
            "truncated": result["truncated"],
        }

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
        lease = (
            self.occupancy.require_lease(server["hardwareId"])
            if tool["kind"] == "hardware"
            else None
        )
        options = options or {}
        return await self.transports.call_tool(
            external_name,
            args,
            {
                **options,
                "metadata": {
                    **options.get("metadata", {}),
                    "hardwareId": server["hardwareId"],
                    **({"occupancyLeaseId": lease} if lease else {}),
                },
            },
        )

    async def close(self) -> None:
        await self.occupancy.close()
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
