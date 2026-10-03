from __future__ import annotations

import json
from pathlib import Path

import pytest

from hardwareharness_backend.devices.device_store import DeviceStore
from hardwareharness_backend.host.register_firedap import register
from hardwareharness_backend.storage.secrets import MemorySecretBackend, SecretStore


async def test_registration_uses_python_catalog_keyring_and_backup(tmp_path: Path) -> None:
    backend = MemorySecretBackend()
    repository = Path(__file__).resolve().parents[4]
    model = repository / "mcp_servers/hardware-manuals/stm32-batianhu-v2"
    server = tmp_path / "中文 服务's"
    server.mkdir()
    config = {
        "serverId": "FIREDAP_MCP",
        "hardwareId": "LOCAL_MCP.FIREDAP_0",
        "port": 8800,
        "token": "never-plaintext",
    }
    (server / "server.json").write_text(json.dumps(config), encoding="utf-8-sig")
    profile = tmp_path / "profile"
    result = await register(profile, server, model, backend)
    assert result["ok"] and result["boardPorts"] == 14
    store = DeviceStore(profile / "devices")
    await store.initialize()
    configured = store.get_server("FIREDAP_MCP")
    assert configured and configured["url"] == "http://127.0.0.1:8800/mcp"
    hardware = store.get_hardware("DUT_1")
    assert hardware and hardware["kind"] == "passive" and len(hardware["ports"]) == 14
    assert (profile / "devices/hardware/DUT_1/model.json").read_bytes() == (
        model / "model.json"
    ).read_bytes()
    secret_path = profile / "secret-keys.json"
    original = secret_path.read_bytes()
    assert b"never-plaintext" not in original
    secrets = SecretStore(profile, backend)
    await secrets.initialize()
    assert secrets.get("mcp:FIREDAP_MCP") == {"token": config["token"]}
    second = await register(profile, server, model, backend)
    assert (Path(second["backup"]) / "secret-keys.json").read_bytes() == original
    assert (Path(second["backup"]) / "devices/hardware/DUT_1/model.json").is_file()
    await store.save_server({**configured, "hardwareId": "OTHER"})
    with pytest.raises(RuntimeError, match="already controls another hardware"):
        await register(profile, server, model, backend)
    assert secret_path.read_bytes() == original
