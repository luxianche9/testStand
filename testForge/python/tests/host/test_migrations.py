"""The existing desktop global migration is retained through Python startup."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from testforge_backend.compat import UNDEFINED
from testforge_backend.compat import filesystem as fs
from testforge_backend.contracts.devices import parse_stored_hardware_definition
from testforge_backend.host import migrations
from testforge_backend.host.migrations import migrate_global_storage
from testforge_backend.storage import SecretStore


class Protector:
    def encrypt(self, value: str) -> bytes:
        return ("protected:" + value).encode()

    def decrypt(self, value: bytes) -> str:
        return value.decode()[len("protected:") :]


@pytest.mark.ts_case(
    "apps/desktop/src/main/migrations.test.ts::migrates legacy entities, settings "
    "and encrypted credentials through a validated stage"
)
async def test_legacy_entities_settings_and_credentials(tmp_path: Path) -> None:
    computers = tmp_path / "devices/computers"
    servers = tmp_path / "devices/servers/S1"
    computers.mkdir(parents=True)
    servers.mkdir(parents=True)
    (computers / "PC1.json").write_text(
        json.dumps(
            {
                "id": "PC1",
                "label": "PC",
                "address": "10.0.0.2",
                "ssh": {"port": 22, "username": "user", "credentialRef": "old-ssh"},
            }
        )
    )
    (servers / "server.json").write_text(
        json.dumps(
            {
                "serverId": "S1",
                "computerId": "PC1",
                "hardwareId": "CARD",
                "label": "Card",
                "url": "http://10.0.0.2:8011/mcp",
                "credentialRef": "old-mcp",
                "enabled": True,
                "lifecycle": {
                    "statusCommand": "s",
                    "startCommand": "b",
                    "stopCommand": "t",
                    "logPath": "l",
                },
            }
        )
    )
    protector = Protector()
    database = sqlite3.connect(tmp_path / "testforge-global-v2.db")
    database.executescript(
        "CREATE TABLE credentials(ref TEXT PRIMARY KEY, encrypted BLOB); "
        "CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);"
    )
    for key, value in [
        ("old-ssh", {"kind": "password", "password": "pw"}),
        ("old-mcp", {"token": "mt"}),
    ]:
        database.execute(
            "INSERT INTO credentials VALUES (?,?)", (key, protector.encrypt(json.dumps(value)))
        )
    database.execute("INSERT INTO settings VALUES ('theme','dark')")
    database.commit()
    database.close()
    assert await migrate_global_storage(tmp_path, protector)
    server = json.loads((tmp_path / "devices/servers/S1.json").read_text())
    assert "credentialRef" not in server
    hardware = json.loads((tmp_path / "devices/hardware/CARD/hardware.json").read_text())
    assert hardware["formatVersion"] == 2 and hardware["hardwareId"] == "CARD"
    secrets = SecretStore(tmp_path / "secrets.json", protector)
    await secrets.initialize()
    assert secrets.get("ssh:PC1")["password"] == "pw"
    assert secrets.get("mcp:S1")["token"] == "mt"
    assert json.loads((tmp_path / "settings.json").read_text())["theme"] == "dark"
    assert list((tmp_path / "backups").glob("storage-*"))
    assert not await migrate_global_storage(tmp_path, protector)


async def test_incomplete_current_storage_is_not_silently_replaced(tmp_path: Path) -> None:
    original = b'{"partial":true}'
    (tmp_path / "settings.json").write_bytes(original)
    with pytest.raises(Exception, match="Global storage is incomplete"):
        await migrate_global_storage(tmp_path, Protector())
    assert (tmp_path / "settings.json").read_bytes() == original


async def test_clean_install_has_no_legacy_migration(tmp_path: Path) -> None:
    assert not await migrate_global_storage(tmp_path, Protector())
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("ports", [None, UNDEFINED, []])
async def test_legacy_hardware_nullish_ports_default_to_empty(tmp_path: Path, ports: Any) -> None:
    directory = tmp_path / "devices/hardware/H"
    directory.mkdir(parents=True)
    raw = {"hardwareId": "H", "label": "Hardware"}
    if ports is not UNDEFINED:
        raw["ports"] = ports
    (directory / "hardware.json").write_text(json.dumps(raw))
    assert await migrate_global_storage(tmp_path, Protector())
    assert json.loads((directory / "hardware.json").read_text())["ports"] == []


@pytest.mark.parametrize("from_database", [False, True])
async def test_null_legacy_computer_throws_before_publication(
    tmp_path: Path, from_database: bool
) -> None:
    if from_database:
        with sqlite3.connect(tmp_path / "testforge.db") as database:
            database.execute("CREATE TABLE computers(document TEXT)")
            database.execute("INSERT INTO computers VALUES ('null')")
    else:
        directory = tmp_path / "devices/computers"
        directory.mkdir(parents=True)
        (directory / "null.json").write_text("null")
    with pytest.raises(TypeError) as caught:
        await migrate_global_storage(tmp_path, Protector())
    assert str(caught.value) == "Cannot read properties of null (reading 'ssh')"
    assert not (tmp_path / "settings.json").exists()
    assert not list(tmp_path.glob(".storage-migration-*"))


async def test_empty_credential_buffer_still_reaches_decryption(tmp_path: Path) -> None:
    seen: list[bytes] = []

    class EmptyProtector(Protector):
        def decrypt(self, value: bytes) -> str:
            seen.append(value)
            return '{"token":"empty-buffer"}'

    protector = EmptyProtector()
    target = SecretStore(tmp_path / "secrets.json", protector)
    await target.initialize()
    with sqlite3.connect(":memory:") as database:
        database.execute("CREATE TABLE credentials(ref TEXT, encrypted BLOB)")
        database.execute("INSERT INTO credentials VALUES (?,?)", ("old", b""))
        await migrations._credential(database, protector, target, "old", "gateway")
    assert seen == [b""]
    assert target.has("gateway")


def test_legacy_document_enumeration_uses_node_utf16_order(tmp_path: Path) -> None:
    for name in ["a", "B", "\U00010000", "\ue000"]:
        (tmp_path / f"{name}.json").write_text(json.dumps(name))
    assert migrations._documents(tmp_path, "") == ["B", "a", "\U00010000", "\ue000"]


async def test_legacy_hardware_enumeration_retains_last_duplicate_in_utf16_order(
    tmp_path: Path,
) -> None:
    for name in ["\ue000", "\U00010000"]:
        directory = tmp_path / "devices/hardware" / name
        directory.mkdir(parents=True)
        (directory / "hardware.json").write_text(json.dumps({"hardwareId": "H", "label": name}))
    assert await migrate_global_storage(tmp_path, Protector())
    stored = json.loads((tmp_path / "devices/hardware/H/hardware.json").read_text("utf-8"))
    assert stored["label"] == "\ue000"


@pytest.mark.parametrize("raw", [None, 1, "text", [], {}])
async def test_invalid_legacy_hardware_preserves_original_property_and_schema_errors(
    tmp_path: Path, raw: Any
) -> None:
    directory = tmp_path / "devices/hardware/H"
    directory.mkdir(parents=True)
    (directory / "hardware.json").write_text(json.dumps(raw))
    with pytest.raises(Exception) as caught:
        await migrate_global_storage(tmp_path, Protector())
    if raw is None:
        assert str(caught.value) == "Cannot read properties of null (reading 'hardwareId')"
    else:
        with pytest.raises(Exception) as expected:
            parse_stored_hardware_definition({"formatVersion": 2, "ports": []})
        assert str(caught.value) == str(expected.value)


async def test_legacy_hardware_utf8_decoder_replaces_invalid_bytes(tmp_path: Path) -> None:
    directory = tmp_path / "devices/hardware/H"
    directory.mkdir(parents=True)
    (directory / "hardware.json").write_bytes(b'{"hardwareId":"H","label":"bad\xff"}')
    assert await migrate_global_storage(tmp_path, Protector())
    stored = json.loads((directory / "hardware.json").read_text("utf-8"))
    assert stored["label"] == "bad\ufffd"


async def test_missing_hardware_image_reports_node_stat_error(tmp_path: Path) -> None:
    directory = tmp_path / "devices/hardware/H"
    directory.mkdir(parents=True)
    (directory / "hardware.json").write_text(
        json.dumps(
            {"hardwareId": "H", "label": "Hardware", "appearanceAssetId": "assets/missing.png"}
        )
    )
    with pytest.raises(OSError) as caught:
        await migrate_global_storage(tmp_path, Protector())
    assert str(caught.value) == (
        f"ENOENT: no such file or directory, stat '{directory / 'assets/missing.png'}'"
    )


async def test_original_partial_publish_failure_keeps_published_settings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    directory = tmp_path / "devices"
    directory.mkdir()
    (directory / "legacy.txt").write_text("keep")
    replace = fs.replace

    def fail_secrets(source: str | Path, target: str | Path) -> None:
        if Path(source).name == "secrets.json":
            raise RuntimeError("simulated publish failure")
        replace(source, target)

    monkeypatch.setattr(fs, "replace", fail_secrets)
    with pytest.raises(RuntimeError, match="simulated publish failure"):
        await migrate_global_storage(tmp_path, Protector())
    assert (tmp_path / "settings.json").exists()
    assert not (tmp_path / "secrets.json").exists()
    assert (directory / "legacy.txt").read_text() == "keep"
    assert not list(tmp_path.glob(".storage-migration-*"))
    with pytest.raises(RuntimeError, match="Global storage is incomplete"):
        await migrate_global_storage(tmp_path, Protector())


async def test_existing_devices_file_is_backed_up_and_replaced_like_recursive_cp(
    tmp_path: Path,
) -> None:
    (tmp_path / "devices").write_bytes(b"legacy-file")
    assert await migrate_global_storage(tmp_path, Protector())
    assert (tmp_path / "devices").is_dir()
    assert next((tmp_path / "backups").glob("storage-*/devices")).read_bytes() == b"legacy-file"


async def test_falsy_sqlite_gateway_reference_is_not_coerced_to_string(tmp_path: Path) -> None:
    with sqlite3.connect(tmp_path / "testforge.db") as database:
        database.executescript(
            "CREATE TABLE settings(key TEXT, value); "
            "CREATE TABLE credentials(ref TEXT, encrypted BLOB);"
        )
        database.execute("INSERT INTO settings VALUES ('gateway.tokenRef', 0)")
    assert await migrate_global_storage(tmp_path, Protector())


async def test_legacy_image_directory_is_rejected_by_non_recursive_cp(tmp_path: Path) -> None:
    directory = tmp_path / "devices/hardware/H"
    asset = directory / "assets/image.png"
    asset.mkdir(parents=True)
    (directory / "hardware.json").write_text(
        json.dumps(
            {"hardwareId": "H", "label": "Hardware", "appearanceAssetId": "assets/image.png"}
        )
    )
    with pytest.raises(OSError) as caught:
        await migrate_global_storage(tmp_path, Protector())
    assert str(caught.value) == (
        f"Path is a directory: cp returned EISDIR ({asset} is a directory (not copied)) {asset}"
    )


async def test_sqlite_null_document_uses_json_parse_coercion(tmp_path: Path) -> None:
    with sqlite3.connect(tmp_path / "testforge.db") as database:
        database.execute("CREATE TABLE computers(document)")
        database.execute("INSERT INTO computers VALUES (NULL)")
    with pytest.raises(TypeError, match="Cannot read properties of null \\(reading 'ssh'\\)"):
        await migrate_global_storage(tmp_path, Protector())


@pytest.mark.parametrize("encrypted", ['protected:{"token":"text"}', 12])
async def test_legacy_credential_matches_buffer_from_sqlite_value(
    tmp_path: Path, encrypted: str | int
) -> None:
    protector = Protector()
    target = SecretStore(tmp_path / "secrets.json", protector)
    await target.initialize()
    with sqlite3.connect(":memory:") as database:
        database.execute("CREATE TABLE credentials(ref TEXT, encrypted)")
        database.execute("INSERT INTO credentials VALUES (?,?)", ("old", encrypted))
        if isinstance(encrypted, str):
            await migrations._credential(database, protector, target, "old", "gateway")
            assert target.get("gateway") == {"token": "text"}
        else:
            with pytest.raises(TypeError) as caught:
                await migrations._credential(database, protector, target, "old", "gateway")
            assert str(caught.value) == (
                "The first argument must be of type string or an instance of Buffer, "
                "ArrayBuffer, or Array or an Array-like Object. Received type number (12)"
            )
