from __future__ import annotations

import asyncio
import logging
from typing import Any

from hardwareharness_backend.contracts.devices import parse_mcp_server
from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.util import utc_now_iso

from .plugin_transport import PluginTransport, declared_streams

Record = dict[str, Any]

log = logging.getLogger(__name__)
SAFE_ALL_TIMEOUT_S = 5.0


class DeviceService:
    def __init__(self, store: Any, transport: PluginTransport) -> None:
        self.store, self.transport = store, transport
        self._server_refreshes: dict[str, asyncio.Task[Record]] = {}
        self._server_statuses: dict[str, Record] = {}
        self._hardware: list[Record] = []
        self._availability: dict[str, Record] = {}
        self._streams: dict[str, list[Record]] = {}

    def list_servers(self) -> list[Record]:
        return list(self.store.list_servers())

    def list_server_statuses(self) -> list[Record]:
        return list(self._server_statuses.values())

    def list_hardware(self) -> list[Record]:
        return self._hardware

    def list_availability(self) -> list[Record]:
        return list(self._availability.values())

    def list_tools(self) -> list[Record]:
        return list(self.transport.list_tools())

    async def call_tool(self, name: str, args: Record, options: Record | None = None) -> Any:
        return await self.call_aggregated_tool(name, args, options)

    async def save_server(self, value: Record) -> Record:
        server = parse_mcp_server(value)
        saved = await self.store.save_server(server)
        await self.transport.disconnect(server["serverId"])
        return dict(saved)

    async def remove_server(self, server_id: str) -> None:
        self._require_server(server_id)
        await self.transport.disconnect(server_id)
        await self.store.remove_server(server_id)
        self._server_statuses.pop(server_id, None)
        self._hardware = [item for item in self._hardware if item["serverId"] != server_id]

    def _require_server(self, server_id: str) -> Record:
        server = self.store.get_server(server_id)
        if not server:
            raise RuntimeError(f"MCP server not found: {server_id}")
        return dict(server)

    async def refresh_server(self, server_id: str) -> Record:
        pending = self._server_refreshes.get(server_id)
        if pending is None:
            pending = asyncio.create_task(self._refresh_server(server_id))
            self._server_refreshes[server_id] = pending
            pending.add_done_callback(lambda _: self._server_refreshes.pop(server_id, None))
        return await asyncio.shield(pending)

    async def _refresh_server(self, server_id: str) -> Record:
        status: Record = {"serverId": server_id, "transport": {"state": "checking"}}
        self._server_statuses.setdefault(server_id, dict(status))
        try:
            server = self._require_server(server_id)
        except Exception as error:
            status["transport"] = {
                "state": "error",
                "checkedAt": utc_now_iso(),
                "message": str(error),
            }
            self._server_statuses[server_id] = status
            return status
        try:
            session = await self.transport.connect(server)
            hardware = session.get("hardware")
            if hardware:
                self._hardware = [item for item in self._hardware if item["serverId"] != server_id]
                self._hardware.append(hardware)
            status["transport"] = {"state": "online", "checkedAt": utc_now_iso()}
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
            self._availability[server["hardwareId"]] = {
                "hardwareId": server["hardwareId"],
                "state": "unavailable",
                "checkedAt": utc_now_iso(),
                "message": str(error),
            }
        self._server_statuses[server_id] = status
        return status

    async def _sync_definition(self, server: Record, hardware_id: str) -> None:
        """Cache the service's ``/device`` when its revision changed."""
        try:
            document = await self.transport.describe_device(server)
            if not isinstance(document, dict):
                return
            self._streams[hardware_id] = declared_streams(document)
            cached = self.store.get_definition(hardware_id)
            revision = document.get("manifestRevision")
            if cached is not None and cached["document"].get("manifestRevision") == revision:
                return
            await self.store.save_definition(hardware_id, document)
        except Exception as error:
            log.warning("Could not refresh the declaration of %s: %s", hardware_id, error)

    def get_definition(self, hardware_id: str) -> Record | None:
        """The managed device's declaration as last cached, read-only (design doc §9.7).

        ``offline`` says the service is not reachable now, so this is the cached version.
        """
        cached = self.store.get_definition(hardware_id)
        if cached is None:
            return None
        document = cached["document"]
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

    async def refresh_all_servers(self) -> list[Record]:
        results = await asyncio.gather(
            *(self.refresh_server(server["serverId"]) for server in self.store.list_servers()),
            return_exceptions=True,
        )
        return [result for result in results if not isinstance(result, BaseException)]

    async def refresh_hardware(self) -> list[Record]:
        self._hardware = await self.transport.list_hardware(self.store.list_servers())
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
        return await self.transport.call_tool(
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
        streams = list(await self.transport.list_streams(self.server_for(hardware_id)))
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

    async def safe_all(self, timeout_s: float = SAFE_ALL_TIMEOUT_S) -> None:
        """Call every connected device's ``safe`` tool; failures are logged, never raised.

        Normal exit runs this so no output is left energized (a crash cannot, by design).
        """
        tools = [
            tool
            for tool in self.list_tools()
            if tool.get("contractMetadata", {}).get("operationSemantics", {}).get("kind") == "safe"
        ]

        async def safe(tool: Record) -> None:
            try:
                await asyncio.wait_for(
                    self.call_aggregated_tool(tool["externalName"], {}), timeout_s
                )
            except Exception as error:
                log.warning("safe_state of %s failed: %s", tool["serverId"], error)

        await asyncio.gather(*(safe(tool) for tool in tools))

    async def read_blob(self, hardware_id: str, stream_id: str, ref: str) -> Record:
        return dict(await self.transport.read_blob(self.server_for(hardware_id), stream_id, ref))
