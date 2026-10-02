"""Offline FireDAP registration; credentials go to the system credential store (§4.7)."""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
from pathlib import Path
from typing import Any

from hardwareharness_backend.devices.device_store import DeviceStore
from hardwareharness_backend.storage.secrets import SecretBackend, SecretStore
from hardwareharness_backend.util import utc_now_iso


async def register(
    user_data: Path, server_root: Path, model_root: Path, backend: SecretBackend | None = None
) -> dict[str, Any]:
    config = json.loads((server_root / "server.json").read_text(encoding="utf-8-sig"))
    store = DeviceStore(user_data / "devices")
    await store.initialize()
    bundle = (model_root / "stm32-batianhu-v2.hhhw").read_bytes()
    preview = await store.inspect_bundle(bundle)
    if preview["hardwareId"] != "DUT_1" or len(preview["ports"]) != 14:
        raise RuntimeError("Unexpected board model scope")
    computer = store.get_computer("LOCAL_PC")
    if computer and computer.get("execution") != "local":
        raise RuntimeError(
            "LOCAL_PC is already a different computer; resolve the identity before registration"
        )
    existing = store.get_server(config["serverId"])
    if existing and existing["hardwareId"] != config["hardwareId"]:
        raise RuntimeError("Server ID already controls another hardware")
    if any(server["hardwareId"] == "DUT_1" for server in store.list_servers()):
        raise RuntimeError("DUT_1 must remain passive")
    timestamp = utc_now_iso().replace(":", "-").replace(".", "-")
    backup = user_data / "backups" / f"firedap-{timestamp}"
    backup.mkdir(parents=True)
    for relative in (
        "secret-keys.json",
        "devices/computers/LOCAL_PC.json",
        "devices/servers/FIREDAP_MCP.json",
        "devices/hardware/DUT_1",
        "devices/hardware/LOCAL_MCP.FIREDAP_0",
    ):
        source, destination = user_data / relative, backup / relative
        if source.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, destination)
            else:
                shutil.copy2(source, destination)
    secrets = SecretStore(user_data, backend)
    await secrets.initialize()
    await store.save_computer(
        {
            "id": "LOCAL_PC",
            "label": "本机",
            "address": "127.0.0.1",
            "execution": "local",
            "ssh": {"port": 22, "username": "local", "shell": "powershell"},
        }
    )

    def command(name: str) -> str:
        return "& '" + str(server_root / name).replace("'", "''") + "'"

    server = {
        "transport": "mcp-http",
        "serverId": config["serverId"],
        "computerId": "LOCAL_PC",
        "label": "FireDAP STM32 烧录服务（本机）",
        "hardwareId": config["hardwareId"],
        "url": f"http://127.0.0.1:{config['port']}/mcp",
        "enabled": True,
        "lifecycle": {
            "statusCommand": command("status.ps1"),
            "startCommand": command("start.ps1"),
            "stopCommand": command("stop.ps1"),
            "logPath": str(server_root / "logs"),
        },
    }
    await secrets.set(f"mcp:{config['serverId']}", {"token": config["token"]})
    await store.save_server(server)
    firedap = json.loads((model_root / "firedap.hardware.json").read_text(encoding="utf-8"))
    await store.save_hardware(firedap)
    await store.put_image_bytes(
        firedap["hardwareId"],
        None,
        (model_root / "images/firedap-appearance.png").read_bytes(),
        "appearance.png",
    )
    await store.import_bundle(bundle)
    shutil.copyfile(model_root / "model.json", user_data / "devices/hardware/DUT_1/model.json")
    await secrets.flush()
    return {
        "ok": True,
        "hardwareIds": [preview["hardwareId"], firedap["hardwareId"]],
        "serverId": server["serverId"],
        "boardPorts": len(preview["ports"]),
        "backup": str(backup),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("user_data", type=Path)
    parser.add_argument("server_root", type=Path)
    parser.add_argument("model_root", type=Path)
    args = parser.parse_args()
    try:
        result = asyncio.run(register(args.user_data, args.server_root, args.model_root))
        print(json.dumps({"result": result}), flush=True)
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
