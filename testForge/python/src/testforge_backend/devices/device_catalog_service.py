from __future__ import annotations

from typing import Any

from testforge_backend.compat import json_stringify

from .device_store import DeviceStore

Record = dict[str, Any]


class DeviceCatalogService:
    def __init__(self, store: DeviceStore) -> None:
        self.store = store
        self._port_index_signature = ""
        self._port_index: dict[str, Record] = {}

    def list_hardware(self) -> list[Record]:
        return self.store.list_hardware()

    def get_hardware(self, hardware_id: str) -> Record:
        return self.store.require_hardware(hardware_id)

    def find_hardware(self, hardware_id: str) -> Record | None:
        return self.store.get_hardware(hardware_id)

    async def save_hardware(self, value: Record) -> Record:
        saved = await self.store.save_hardware(value)
        self._port_index_signature = ""
        return saved

    async def remove_hardware(self, hardware_id: str) -> None:
        await self.store.remove_hardware(hardware_id)
        self._port_index_signature = ""

    def hardware_for_server(self, server_id: str) -> Record | None:
        return next(
            (
                item
                for item in self.list_hardware()
                if item["kind"] == "managed" and item.get("serverId") == server_id
            ),
            None,
        )

    def resolve_port(self, port_ref: str) -> Record:
        hardware = self.list_hardware()
        # Approved TS bug exception: imports/image writes bypass the catalog, so ids alone
        # cannot identify the cached objects. Include contents to invalidate those updates.
        signature = json_stringify(hardware)
        if signature != self._port_index_signature:
            self._port_index = {
                f"{item['hardwareId']}.{port['portId']}": {"hardware": item, "port": port}
                for item in hardware
                for port in item["ports"]
            }
            self._port_index_signature = signature
        if port_ref in self._port_index:
            return self._port_index[port_ref]
        first, separator, rest = port_ref.partition(".")
        if separator and first and any(item["hardwareId"] == first for item in hardware):
            raise RuntimeError(f"Hardware {first} has no port {rest}")
        raise RuntimeError(f"No hardware matches port reference {port_ref}")

    def validate_pins(self, port_a: str, port_b: str, pins: list[Record]) -> None:
        a = self.resolve_port(port_a)["port"]
        b = self.resolve_port(port_b)["port"]
        known_a = {pin["pinId"] for pin in a["pins"]}
        known_b = {pin["pinId"] for pin in b["pins"]}
        seen = set()
        for pair in pins:
            if pair["a"] not in known_a:
                raise RuntimeError(f"Port {port_a} has no pin {pair['a']}")
            if pair["b"] not in known_b:
                raise RuntimeError(f"Port {port_b} has no pin {pair['b']}")
            key = (pair["a"], pair["b"])
            if key in seen:
                raise RuntimeError(f"Duplicate pin pair {pair['a']} - {pair['b']}")
            seen.add(key)

    def warnings_for_ports(self, port_a: str, port_b: str) -> list[str]:
        warnings = []
        for reference in [port_a, port_b]:
            try:
                resolved = self.resolve_port(reference)
                hardware, port = resolved["hardware"], resolved["port"]
                if not port.get("imageAssetId"):
                    warnings.append(f"{hardware['label']} 的端口 {port['name']} 还没有上传端口图")
            except Exception as error:
                warnings.append(str(error))
        return warnings
