from __future__ import annotations

from typing import Any

from hardwareharness_backend.contracts.devices import adapter_release_gaps
from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.util import json_dumps, utc_now_iso

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

    def _managed(self, hardware_id: str) -> Record:
        hardware = self.store.get_hardware(hardware_id)
        if hardware is None:
            raise app_error("not_found", f"Hardware {hardware_id} does not exist")
        if hardware["kind"] != "managed":
            raise app_error(
                "invalid_argument", f"Hardware {hardware_id} has no adapter (it is passive)"
            )
        return hardware

    def adapter_status(self, hardware_id: str) -> Record:
        """The adapter release record (design doc 8.4) and the gates it still misses."""
        self._managed(hardware_id)
        record = self.store.get_adapter(hardware_id)
        return {**record, "gaps": adapter_release_gaps(record)}

    async def record_adapter_check(self, hardware_id: str, kind: str, note: str = "") -> Record:
        """``kind`` (``check`` / ``simulator``) passed now."""
        self._managed(hardware_id)
        record = self.store.get_adapter(hardware_id)
        record[kind] = {"at": utc_now_iso(), "note": note}
        await self.store.save_adapter(record)
        return self.adapter_status(hardware_id)

    async def record_adapter_smoke(self, hardware_id: str, smoke: Record) -> Record:
        self._managed(hardware_id)
        record = self.store.get_adapter(hardware_id)
        record["smoke"] = [*record["smoke"], {"at": utc_now_iso(), **smoke}]
        await self.store.save_adapter(record)
        return self.adapter_status(hardware_id)

    async def set_adapter_status(self, hardware_id: str, status: str) -> Record:
        self._managed(hardware_id)
        record = self.store.get_adapter(hardware_id)
        gaps = adapter_release_gaps(record)
        if status == "available" and gaps:
            raise app_error(
                "conflict",
                f"Adapter {hardware_id} cannot be marked available yet",
                {
                    "gaps": gaps,
                    "recovery": "Record --check, simulator tests and a manual bench smoke run.",
                },
            )
        record["status"] = status
        await self.store.save_adapter(record)
        self._port_index_signature = ""
        return self.adapter_status(hardware_id)

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
        signature = json_dumps(hardware)
        if signature != self._port_index_signature:
            self._port_index = {
                f"{item['hardwareId']}.{port['portId']}": {"hardware": item, "port": port}
                for item in hardware
                for port in item["ports"]
            }
            self._port_index_signature = signature
        if port_ref in self._port_index:
            return self._port_index[port_ref]
        matches = [
            (ref, item)
            for ref, item in self._port_index.items()
            if port_ref
            in {
                item["port"]["portId"],
                f"{item['hardware']['hardwareId']}."
                + item["port"]["portId"].removeprefix(item["hardware"]["hardwareId"] + "."),
            }
        ]
        if len(matches) == 1:
            return matches[0][1]
        prefix = next(
            (
                item["hardwareId"]
                for item in sorted(hardware, key=lambda item: len(item["hardwareId"]), reverse=True)
                if port_ref.startswith(item["hardwareId"] + ".")
            ),
            None,
        )
        message = (
            f"Ambiguous port reference: {port_ref}"
            if matches
            else f"Hardware {prefix} has no port {port_ref[len(prefix) + 1 :]}"
            if prefix
            else f"No hardware matches port reference {port_ref}"
        )
        raise app_error(
            "conflict" if matches else "not_found",
            message,
            {
                "endpointRef": port_ref,
                "candidates": [ref for ref, _ in matches],
                "recovery": "Read get_hardware_definition and copy ports[].endpointRef exactly.",
            },
        )

    def validate_pins(self, port_a: str, port_b: str, pins: list[Record]) -> None:
        if port_a == port_b and (not pins or any(pin["a"] == pin["b"] for pin in pins)):
            raise app_error("invalid_argument", "Same-port wiring requires distinct pin pairs")
        a = self.resolve_port(port_a)["port"]
        b = self.resolve_port(port_b)["port"]
        known_a = {pin["pinId"] for pin in a["pins"]}
        known_b = {pin["pinId"] for pin in b["pins"]}
        seen = set()
        for pair in pins:
            if pair["a"] not in known_a:
                raise app_error(
                    "invalid_argument",
                    f"Port {port_a} has no pin {pair['a']}",
                    {"validPinIds": sorted(known_a), "endpointRef": port_a},
                )
            if pair["b"] not in known_b:
                raise app_error(
                    "invalid_argument",
                    f"Port {port_b} has no pin {pair['b']}",
                    {"validPinIds": sorted(known_b), "endpointRef": port_b},
                )
            key = (
                tuple(sorted((pair["a"], pair["b"])))
                if port_a == port_b
                else (pair["a"], pair["b"])
            )
            if key in seen:
                raise app_error("invalid_argument", f"Duplicate pin pair {pair['a']} - {pair['b']}")
            seen.add(key)

    def warnings_for_ports(self, port_a: str, port_b: str) -> list[str]:
        warnings = []
        for reference in dict.fromkeys([port_a, port_b]):
            try:
                resolved = self.resolve_port(reference)
                hardware, port = resolved["hardware"], resolved["port"]
                if not port.get("imageAssetId"):
                    warnings.append(f"{hardware['label']} 的端口 {port['name']} 还没有上传端口图")
            except Exception as error:
                warnings.append(str(error))
        return warnings
