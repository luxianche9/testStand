"""Deploying, upgrading and uninstalling services from the terminal (design doc 4.8.3, DEC-07).

The interface, the Agent gateway and the maintainers' command line all go through
:class:`DeployService`, so every path keeps the same safeguards (``pipeline.py``).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.devices.service_registry import probe_service, register_service

from .bundle import Bundle, assemble, list_adapters, load_bundle, mcp_source_root
from .hosts import LocalHost, SshHost
from .pipeline import (
    DeploySpec,
    Progress,
    RemoteHost,
    default_root,
    deploy,
    uninstall,
    validate_root,
)

Record = dict[str, Any]
Assembler = Callable[..., Bundle]


class DeployService:
    def __init__(
        self,
        devices: Any,
        catalog: Any,
        source: Callable[[], Path] = mcp_source_root,
        assembler: Assembler = assemble,
    ) -> None:
        self.devices, self.catalog = devices, catalog
        self.source, self.assembler = source, assembler

    def host(self, computer_id: str) -> RemoteHost:
        computer = self.devices.require_powershell(computer_id)
        return (
            LocalHost()
            if computer.get("execution") == "local"
            else SshHost(self.devices.ssh, computer)
        )

    def list_adapters(self) -> list[Record]:
        return list_adapters(self.source())

    async def build(self, spec: Record, *, wheels: bool = True) -> Bundle:
        return await asyncio.to_thread(
            self.assembler,
            self.source(),
            spec["serverId"],
            spec["hardwareId"],
            spec["adapter"],
            wheels=wheels,
        )

    async def deploy(
        self,
        computer_id: str,
        spec: Record,
        *,
        bundle_dir: Path | None = None,
        progress: Progress | None = None,
    ) -> Record:
        """Deploy a new service or upgrade the one already under the same root."""
        computer = self.devices.require_powershell(computer_id)
        server_id, hardware_id = spec["serverId"], spec["hardwareId"]
        existing = self.devices.store.get_server(server_id)
        if existing and existing.get("computerId") != computer_id:
            raise app_error(
                "conflict",
                f"{server_id} is already registered "
                + (f"on {existing['computerId']}" if existing.get("computerId") else "by URL"),
            )
        if existing and existing.get("hardwareId") != hardware_id:
            raise app_error("conflict", f"{server_id} drives {existing.get('hardwareId')}")
        bound = self.catalog.find_hardware(hardware_id)
        if bound and bound.get("serverId") not in {None, server_id}:
            raise app_error("conflict", f"Hardware {hardware_id} is bound to {bound['serverId']}")
        root = validate_root(
            spec.get("root") or (existing or {}).get("root") or default_root(server_id)
        )
        if existing and existing.get("root") and validate_root(existing["root"]) != root:
            raise app_error(
                "invalid_argument",
                f"{server_id} is installed in {existing['root']}; uninstall it before moving it",
            )
        bundle = load_bundle(bundle_dir) if bundle_dir else await self.build(spec)

        async def stop_old() -> None:
            if not existing:
                raise app_error(
                    "safe_stop_failed",
                    f"A service is running in {root} but is not added to this terminal; import "
                    "it from the computer first so it can be stopped safely.",
                )
            await self.devices.server_action(server_id, "stop")

        async def verify_device(token: str, port: int) -> None:
            identity = await probe_service(f"http://{computer['address']}:{port}/mcp", token)
            if identity["serverId"] != server_id or identity["hardwareId"] != hardware_id:
                raise app_error(
                    "conflict",
                    f"/device reports {identity['serverId']} / {identity['hardwareId']}",
                )

        outcome = await deploy(
            self.host(computer_id),
            bundle,
            DeploySpec(
                server_id=server_id,
                hardware_id=hardware_id,
                root=root,
                port=int(spec["port"]),
                computer_id=computer_id,
                settings=dict(spec.get("settings") or {}),
                dry_run=bool(spec.get("dryRun", False)),
                autostart=bool(spec.get("autostart", True)),
            ),
            stop_old=stop_old,
            verify_device=verify_device,
            progress=progress,
        )
        label = (
            str(spec.get("label") or "").strip()
            or (existing or {}).get("label")
            or f"{bundle.build['manufacturer']} {bundle.build['model']}"
        )
        server = {key: value for key, value in (existing or {}).items() if key != "lifecycle"} | {
            "transport": "mcp-http",
            "serverId": server_id,
            "computerId": computer_id,
            "label": label,
            "hardwareId": hardware_id,
            "url": f"http://{computer['address']}:{outcome.port}/mcp",
            "enabled": True,
            "root": outcome.root,
        }
        registered = await register_service(self.devices, self.catalog, server, outcome.token)
        return {**outcome.public(), **registered}

    async def uninstall(self, server_id: str, *, progress: Progress | None = None) -> Record:
        server = self.devices.store.get_server(server_id)
        if not server:
            raise app_error("not_found", f"MCP server not found: {server_id}")
        if not server.get("computerId") or not server.get("root"):
            raise app_error(
                "invalid_argument",
                f"{server_id} has no computer and root; only deployed services can be uninstalled",
            )
        self.devices.require_powershell(server["computerId"])
        try:
            template: bytes | None = (self.source() / "templates" / "uninstall.ps1").read_bytes()
        except Exception:
            template = None
        result = await uninstall(
            self.host(server["computerId"]),
            server["root"],
            server_id,
            stop_old=lambda: self.devices.server_action(server_id, "stop"),
            uninstall_script=template,
            progress=progress,
        )
        hardware = self.catalog.hardware_for_server(server_id)
        await self.devices.remove_server(server_id)
        if hardware:
            await self.catalog.remove_hardware(hardware["hardwareId"])
        return {**result, "serverId": server_id}
