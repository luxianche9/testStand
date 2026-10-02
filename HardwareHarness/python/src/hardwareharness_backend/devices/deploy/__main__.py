"""Maintainers' command line for deploying services (DEC-07); replaces ``mcp_servers/deploy.ps1``.

    python -m hardwareharness_backend.devices.deploy adapters
    python -m hardwareharness_backend.devices.deploy assemble --server-id CP118U_MCP ...
    python -m hardwareharness_backend.devices.deploy deploy --user-data <dir> --computer PC ...
    python -m hardwareharness_backend.devices.deploy uninstall --user-data <dir> --server-id ...

``deploy`` and ``uninstall`` use the same code as the interface and the Agent gateway and
write the terminal's registry and keyring under ``--user-data``; close the desktop app first.
Progress goes to stderr, the final ``{"result": ...}`` line to stdout. Tokens are never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from hardwareharness_backend.devices.device_catalog_service import DeviceCatalogService
from hardwareharness_backend.devices.device_service import DeviceService
from hardwareharness_backend.devices.device_store import DeviceStore
from hardwareharness_backend.devices.device_transport import DeviceTransportRegistry
from hardwareharness_backend.devices.mcp_client import McpHttpTransport
from hardwareharness_backend.storage.secrets import SecretStore

from .bundle import assemble, list_adapters, mcp_source_root
from .service import DeployService

Record = dict[str, Any]


def _progress(item: Record) -> None:
    print(json.dumps(item, ensure_ascii=False), file=sys.stderr, flush=True)


def _spec(args: argparse.Namespace) -> Record:
    spec: Record = {
        "serverId": args.server_id,
        "hardwareId": args.hardware_id,
        "adapter": args.adapter,
        "port": args.port,
        "dryRun": args.dry_run,
        "autostart": not args.no_autostart,
    }
    if args.root:
        spec["root"] = args.root
    if args.label:
        spec["label"] = args.label
    if args.settings:
        spec["settings"] = json.loads(Path(args.settings).read_text(encoding="utf-8-sig"))
    return spec


async def _with_services(user_data: Path, action: Any) -> Any:
    secrets = SecretStore(user_data)
    await secrets.initialize()
    store = DeviceStore(user_data / "devices")
    await store.initialize()
    devices = DeviceService(store, secrets, DeviceTransportRegistry([McpHttpTransport(secrets)]))
    try:
        return await action(DeployService(devices, DeviceCatalogService(store)))
    finally:
        await devices.close()
        await secrets.flush()


async def run(args: argparse.Namespace) -> Any:
    source = Path(args.source).resolve() if args.source else mcp_source_root()
    if args.command == "adapters":
        return list_adapters(source)
    if args.command == "assemble":
        bundle = await asyncio.to_thread(
            assemble,
            source,
            args.server_id,
            args.hardware_id,
            args.adapter,
            wheels=not args.no_wheels,
        )
        return {"root": str(bundle.root), "files": len(bundle.files), "build": bundle.build}
    if args.command == "deploy":
        bundle_dir = Path(args.bundle) if args.bundle else None
        return await _with_services(
            args.user_data,
            lambda deploy: deploy.deploy(
                args.computer, _spec(args), bundle_dir=bundle_dir, progress=_progress
            ),
        )
    return await _with_services(
        args.user_data, lambda deploy: deploy.uninstall(args.server_id, progress=_progress)
    )


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="python -m hardwareharness_backend.devices.deploy")
    root.add_argument("--source", help="mcp_servers directory (default: auto-detected)")
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("adapters", help="list deployable adapters")
    for name in ("assemble", "deploy"):
        command = commands.add_parser(name)
        command.add_argument("--server-id", required=True)
        command.add_argument("--hardware-id", required=True)
        command.add_argument("--adapter", required=True)
        command.add_argument("--no-wheels", action="store_true", help="skip offline wheels")
    deploy = commands.choices["deploy"]
    deploy.add_argument("--user-data", type=Path, required=True)
    deploy.add_argument("--computer", required=True, help="computerId in the terminal registry")
    deploy.add_argument("--port", type=int, required=True)
    deploy.add_argument("--root", help="Windows install directory")
    deploy.add_argument("--label")
    deploy.add_argument("--settings", help="JSON file with adapter settings for a new server.json")
    deploy.add_argument("--bundle", help="deploy an already assembled bundle directory")
    deploy.add_argument(
        "--dry-run", action="store_true", help="a new server.json runs the simulated drivers"
    )
    deploy.add_argument("--no-autostart", action="store_true")
    uninstall = commands.add_parser("uninstall")
    uninstall.add_argument("--user-data", type=Path, required=True)
    uninstall.add_argument("--server-id", required=True)
    return root


def main(argv: list[str] | None = None) -> None:
    args = parser().parse_args(argv)
    try:
        result = asyncio.run(run(args))
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
    print(json.dumps({"result": result}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
