from __future__ import annotations

import asyncio
from typing import Any, Protocol

Record = dict[str, Any]
DeviceCallMetadata = Record
DeviceCallOptions = Record
DeviceTransportConnection = Record


class DeviceTransport(Protocol):
    kind: str

    async def connect(self, server: Record) -> Record: ...
    async def disconnect(self, server_id: str) -> None: ...
    async def close(self) -> None: ...
    def list_tools(self) -> list[Record]: ...
    def has_tool(self, external_name: str) -> bool: ...
    async def call(
        self, external_name: str, args: Record, options: Record | None = None
    ) -> Any: ...
    async def call_internal(
        self, server: Record, name: str, args: Record, options: Record | None = None
    ) -> Any: ...
    async def describe_hardware(self, server: Record) -> Record: ...
    async def list_streams(self, server: Record) -> list[Record]: ...
    async def describe_device(self, server: Record) -> Record | None: ...
    async def read_blob(self, server: Record, stream_id: str, ref: str) -> Record: ...
    async def prepare_shutdown(self, server_id: str) -> Any: ...


class DeviceTransportRegistry:
    def __init__(self, transports: list[DeviceTransport]) -> None:
        self._by_kind = {transport.kind: transport for transport in transports}
        self._server_kinds: dict[str, str] = {}
        if len(self._by_kind) != len(transports):
            raise RuntimeError("Duplicate device transport kind")

    async def connect(self, server: Record) -> Record:
        connection = await self._require_transport(server["transport"]).connect(server)
        self._server_kinds[server["serverId"]] = server["transport"]
        return connection

    async def disconnect(self, server_id: str) -> None:
        kind = self._server_kinds.pop(server_id, None)
        if kind:
            await self._require_transport(kind).disconnect(server_id)
        else:
            await asyncio.gather(
                *(transport.disconnect(server_id) for transport in self._by_kind.values())
            )

    async def close(self) -> None:
        self._server_kinds.clear()
        await asyncio.gather(*(transport.close() for transport in self._by_kind.values()))

    def list_tools(self) -> list[Record]:
        return [tool for transport in self._by_kind.values() for tool in transport.list_tools()]

    async def call_tool(self, name: str, args: Record, options: Record | None = None) -> Any:
        transport = next((item for item in self._by_kind.values() if item.has_tool(name)), None)
        if not transport:
            raise RuntimeError(f"Unknown aggregated tool: {name}")
        return await transport.call(name, args, options)

    async def call_internal(
        self, server: Record, name: str, args: Record, options: Record | None = None
    ) -> Any:
        transport = self._require_transport(server["transport"])
        await transport.connect(server)
        self._server_kinds[server["serverId"]] = server["transport"]
        return await transport.call_internal(server, name, args, options)

    async def list_hardware(self, servers: list[Record]) -> list[Record]:
        async def describe(server: Record) -> Record:
            hardware = await self._require_transport(server["transport"]).describe_hardware(server)
            self._server_kinds[server["serverId"]] = server["transport"]
            return hardware

        results = await asyncio.gather(
            *(describe(server) for server in servers if server["enabled"]), return_exceptions=True
        )
        return [item for item in results if not isinstance(item, BaseException)]

    async def list_streams(self, server: Record) -> list[Record]:
        transport = self._require_transport(server["transport"])
        self._server_kinds[server["serverId"]] = server["transport"]
        return await transport.list_streams(server)

    async def read_blob(self, server: Record, stream_id: str, ref: str) -> Record:
        return await self._require_transport(server["transport"]).read_blob(server, stream_id, ref)

    async def describe_device(self, server: Record) -> Record | None:
        """``/device`` of the service; ``None`` when its transport has no declarations."""
        transport = self._require_transport(server["transport"])
        describe = getattr(transport, "describe_device", None)
        if describe is None:
            return None
        self._server_kinds[server["serverId"]] = server["transport"]
        result: Record | None = await describe(server)
        return result

    async def prepare_shutdown(self, server: Record) -> Any:
        return await self._require_transport(server["transport"]).prepare_shutdown(
            server["serverId"]
        )

    def _require_transport(self, kind: str) -> DeviceTransport:
        if kind not in self._by_kind:
            raise RuntimeError(f"Unsupported device transport: {kind}")
        return self._by_kind[kind]
