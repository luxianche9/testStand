"""Device plugins loaded into the backend process (design: single-machine plugin model).

A ``plugin`` instance record names a device type (its ``hardwareharness.devices`` entry point),
its non-secret ``settings`` and ``mode`` (``sim`` runs the adapter's simulator). Connecting
loads the device through :func:`hardwareharness_device_sdk.open_device`, in this process or in
an isolated child process as the adapter's ``Device.isolation`` asks, and opens it (the SDK
drives it to its safe state right after ``open``). Disconnecting drives it safe and closes it.
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Callable
from typing import Any

from hardwareharness_device_sdk import (
    DeviceConfig,
    DeviceHandle,
    device_types,
    load_device,
    open_device,
)

from hardwareharness_backend.contracts.devices import (
    parse_managed_hardware,
    parse_reported_managed_hardware,
)
from hardwareharness_backend.contracts.errors import AppError, app_error
from hardwareharness_backend.util import clone

from .schema_validation import schema_error
from .tool_catalog import catalog_entry, request_arguments, unwrap_result

Record = dict[str, Any]
Opener = Callable[[str, DeviceConfig], DeviceHandle]

DEFAULT_TIMEOUT_MS = 60_000
RECOVERY = (
    "Query device state before any new action. A timeout or a crashed device process "
    "does not undo a physical operation."
)
CHILD_FLAG = "--device-child"
"""Argument that makes the frozen backend executable run an isolated device instead."""


def child_command() -> list[str] | None:
    """How to start an isolated device: the SDK module, or this executable when frozen."""
    if getattr(sys, "frozen", False):
        return [sys.executable, CHILD_FLAG]
    return None


def declared_streams(document: Record) -> list[Record]:
    """``/device.streams[]`` entries that name an ``id`` and a ``type``, as declared."""
    streams = document.get("streams")
    return [
        {**item, "id": str(item["id"]), "type": str(item["type"])}
        for item in (streams if isinstance(streams, list) else [])
        if isinstance(item, dict) and "id" in item and "type" in item
    ]


def plugin_config(instance: Record) -> DeviceConfig:
    device_cls = load_device(instance["type"])
    return DeviceConfig.from_mapping(
        {
            "deviceId": instance["deviceId"],
            "hardwareId": instance["hardwareId"],
            "manufacturer": device_cls.manufacturer,
            "model": device_cls.model,
            "computerId": "LOCAL",
            "dryRun": instance["mode"] == "sim",
            "settings": instance.get("settings") or {},
        },
        env={},
    )


def installed_device_types() -> list[Record]:
    """``[{type, manufacturer, model, isolation, description}]``; a type that fails to import
    is reported with its ``error`` so the device page can say why it cannot be added."""
    output: list[Record] = []
    for name in sorted(device_types()):
        try:
            device_cls = load_device(name)
        except Exception as error:
            output.append({"type": name, "error": str(error)})
            continue
        output.append(
            {
                "type": name,
                "manufacturer": device_cls.manufacturer,
                "model": device_cls.model,
                "isolation": device_cls.isolation,
                "description": device_cls.description,
            }
        )
    return output


def _open(device_type: str, config: DeviceConfig) -> DeviceHandle:
    return open_device(device_type, config, child_command=child_command())


class PluginTransport:
    def __init__(self, opener: Opener = _open) -> None:
        self.opener = opener
        self.sessions: dict[str, Record] = {}
        self._connecting: dict[str, asyncio.Lock] = {}

    # -- lifecycle -----------------------------------------------------------------------------

    async def connect(self, instance: Record) -> Record:
        identifier = instance["deviceId"]
        async with self._connecting.setdefault(identifier, asyncio.Lock()):
            existing = self.sessions.get(identifier)
            if existing is not None and existing["instance"] == instance:
                return existing
            if existing is not None:
                await self.disconnect(identifier)
            device = self.opener(instance["type"], plugin_config(instance))
            await device.start()
            try:
                session: Record = {"instance": clone(instance), "device": device}
                await self._describe(session)
            except BaseException:
                await device.stop()
                raise
            self.sessions[identifier] = session
            return session

    async def disconnect(self, device_id: str) -> None:
        session = self.sessions.pop(device_id, None)
        if session is not None:
            await session["device"].stop()

    async def close(self) -> None:
        await asyncio.gather(*(self.disconnect(device_id) for device_id in list(self.sessions)))

    async def ensure(self, instance: Record) -> Record:
        return self.sessions.get(instance["deviceId"]) or await self.connect(instance)

    def device_for(self, hardware_id: str) -> DeviceHandle | None:
        """The loaded device that owns ``hardware_id`` (``None``: not a connected plugin)."""
        return next(
            (
                session["device"]
                for session in self.sessions.values()
                if session["instance"]["hardwareId"] == hardware_id
            ),
            None,
        )

    async def _describe(self, session: Record) -> None:
        instance = session["instance"]
        described = await session["device"].describe()
        tools: list[Record] = []
        validators: dict[str, Record] = {}
        for raw in described["tools"]:
            entry, validators[raw["name"]] = catalog_entry(instance["deviceId"], raw)
            tools.append(entry)
        hardware = described["hardware"]
        if not isinstance(hardware, list) or len(hardware) != 1:
            raise RuntimeError(f"Device {instance['deviceId']} must manage exactly one hardware")
        item = parse_reported_managed_hardware(hardware[0])
        if item["hardwareId"] != instance["hardwareId"]:
            raise RuntimeError(
                f"Device {instance['deviceId']} reports hardwareId {item['hardwareId']}; "
                f"expected {instance['hardwareId']}"
            )
        session.update(
            tools=tools,
            validators=validators,
            hardware=parse_managed_hardware({**item, "deviceId": instance["deviceId"]}),
            device_document=described["device"],
            streams=declared_streams(described["device"]),
        )

    # -- tools ---------------------------------------------------------------------------------

    def list_tools(self) -> list[Record]:
        return [
            tool
            for session in self.sessions.values()
            for tool in session["tools"]
            if tool["kind"] != "internal"
        ]

    def _find(self, external_name: str) -> tuple[Record, Record]:
        for session in self.sessions.values():
            for tool in session["tools"]:
                if tool["externalName"] == external_name:
                    return session, tool
        raise RuntimeError(f"Unknown aggregated tool: {external_name}")

    async def call_tool(
        self, external_name: str, args: Record, options: Record | None = None
    ) -> Any:
        session, tool = self._find(external_name)
        return await self._call(session, tool["remoteName"], args, options or {})

    async def _call(self, session: Record, name: str, args: Record, options: Record) -> Any:
        device_id = session["instance"]["deviceId"]
        validators = session["validators"].get(name)
        request_args = request_arguments(validators, args, options.get("metadata"))
        if validators:
            error = schema_error(validators["input"], request_args)
            if error:
                raise app_error("invalid_argument", f"Invalid input for {name}: {error}")
        unknown = {
            "deviceId": device_id,
            "toolName": name,
            "outcomeKnown": False,
            "automaticRetry": False,
            "recovery": RECOVERY,
        }
        call = asyncio.create_task(
            session["device"].call(name, request_args, options.get("operationId"))
        )
        signal = options.get("signal")
        abort = asyncio.create_task(signal.wait()) if signal is not None else None
        timeout_ms = options.get("timeoutMs", DEFAULT_TIMEOUT_MS)
        try:
            done, _ = await asyncio.wait(
                [call] if abort is None else [call, abort],
                timeout=timeout_ms / 1000,
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            if abort is not None:
                abort.cancel()
                await asyncio.gather(abort, return_exceptions=True)
        if call not in done:
            call.cancel()
            await asyncio.gather(call, return_exceptions=True)
            if signal is not None and signal.aborted and signal.reason is not None:
                raise signal.reason
            raise app_error(
                "unavailable", "Request timed out", {**unknown, "timeoutMs": timeout_ms}
            )
        try:
            structured = call.result()
        except AppError:
            raise
        except Exception as failure:
            raise app_error("unavailable", str(failure), unknown) from failure
        return unwrap_result(name, structured, validators, options)

    # -- device ----------------------------------------------------------------------------------

    async def describe_hardware(self, instance: Record) -> Record:
        session = await self.ensure(instance)
        await self._describe(session)
        return dict(session["hardware"])

    async def list_hardware(self, instances: list[Record]) -> list[Record]:
        """The hardware of every enabled instance that can be described now."""
        results = await asyncio.gather(
            *(self.describe_hardware(instance) for instance in instances if instance["enabled"]),
            return_exceptions=True,
        )
        return [item for item in results if not isinstance(item, BaseException)]

    async def describe_device(self, instance: Record) -> Record | None:
        session = await self.ensure(instance)
        await self._describe(session)
        document: Record = clone(session["device_document"])
        return document

    async def list_streams(self, instance: Record) -> list[Record]:
        session = await self.ensure(instance)
        return [dict(item) for item in session["streams"]]

    async def read_blob(self, instance: Record, stream_id: str, ref: str) -> Record:
        session = await self.ensure(instance)
        return dict(await session["device"].read_blob(stream_id, ref))
