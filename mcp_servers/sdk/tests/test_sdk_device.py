"""/device declaration, /assets and heartbeat leases (contract 2026-10-01.1)."""

from __future__ import annotations

import hashlib
import struct
import time
import zlib
from pathlib import Path

import pytest

from hardwareharness_device_sdk import (
    CONTRACT_REVISION,
    ConnectorImage,
    PinPosition,
    __version__,
    function,
    single_connector_pinout,
)
from hardwareharness_device_sdk import lease as lease_rules
from hardwareharness_device_sdk.manifest import AssetError, canonical_json, image_size, resolve_asset
from hardwareharness_device_sdk.testing import check_device, serve

from sdk_demo import DemoDevice

SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200"/></svg>'


def png(width: int, height: int) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    raw = b"".join(b"\0" + b"\0\0\0" * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


@pytest.fixture
def pictured(tmp_path: Path) -> type[DemoDevice]:
    (tmp_path / "ports").mkdir()
    (tmp_path / "appearance.svg").write_bytes(SVG)
    (tmp_path / "ports" / "CN1.png").write_bytes(png(4, 2))
    (tmp_path.parent / "secret.png").write_bytes(png(1, 1))

    class Pictured(DemoDevice):
        assets_path = tmp_path
        hardware_revision = "B1"

        def pinout(self):
            outputs = {index + 1: (function(f"DO{index}", "output", "ttl", channel_kind="DO", channel_index=index),)
                       for index in range(4)}
            image = ConnectorImage(asset="ports/CN1.png", pinPositions=(
                PinPosition(pinId=f"{self.hardware_id}.CN1.1", x=0.1, y=0.5),))
            return single_connector_pinout(self.hardware_id, self.manufacturer, self.model, 5, outputs,
                                           "demo manual", image=image)

    return Pictured


def test_device_declaration_shape(hh):
    assert hh.get("/device", token="").status_code == 401
    document = hh.get("/device").json()
    assert list(document)[0] == "manifestRevision"
    assert document["contractRevision"] == CONTRACT_REVISION
    assert document["identity"] == {"serverId": "DEMO1_MCP", "hardwareId": "DEMO1_1", "manufacturer": "Acme",
                                    "model": "DEMO-1", "adapter": {"name": "sdk_demo", "version": "1.2.3"},
                                    "sdkVersion": __version__, "dryRun": True}
    assert document["description"].startswith("Demo board")
    assert document["images"] == {} and document["pinout"] is None
    assert document["streams"] == [
        {"id": "di", "type": "bits", "width": 4, "bitLabels": ["DI0", "DI1", "DI2", "DI3"], "rateHz": 50.0},
        {"id": "ai0", "type": "scalar", "unit": "V", "rateHz": 50.0, "label": "AI0"},
        {"id": "scope", "type": "block", "rateHz": 20.0},
        {"id": "do", "type": "bits", "width": 4, "kind": "setpoint"},
        {"id": "serial1", "type": "bytes", "writable": True},
        {"id": "cam", "type": "blob"}]
    tools = {item["name"]: item["kind"] for item in document["tools"]}
    assert set(tools) == set(hh.tools)
    assert tools["demo_set_level"] == "actuate" and tools["demo_safe_state"] == "safe"
    assert tools["demo_configure"] == "configure" and tools["demo_read_level"] == "read"
    assert tools["lease_acquire"] == "internal" and tools["hardwareharness_prepare_shutdown"] == "internal"
    assert tools["lease_status"] == "read" and tools["get_server_info"] == "read"
    assert document["capabilities"]["declarationPath"] == "/device"


def test_manifest_revision_is_sha256_of_canonical_body(hh):
    document = hh.get("/device").json()
    revision = document.pop("manifestRevision")
    assert revision == "sha256:" + hashlib.sha256(canonical_json(document)).hexdigest()
    assert hh.get("/device").json()["manifestRevision"] == revision
    assert hh.client.get("/health").json()["manifestRevision"] == revision


def test_device_declaration_with_assets(pictured):
    with serve(pictured) as hh:
        document = hh.get("/device").json()
        assert document["identity"]["hardwareRevision"] == "B1"
        assert document["images"] == {"appearance": {"asset": "appearance.svg", "mediaType": "image/svg+xml",
                                                     "width": 320, "height": 200}}
        connector = document["pinout"]["connectors"][0]
        assert connector["image"] == {"asset": "ports/CN1.png", "mediaType": "image/png",
                                      "pinPositions": [{"pinId": "DEMO1_1.CN1.1", "x": 0.1, "y": 0.5}]}
        # The revision covers the asset bytes as well as the JSON.
        body = {key: value for key, value in document.items() if key != "manifestRevision"}
        digest = hashlib.sha256(canonical_json(body))
        for path in ("appearance.svg", "ports/CN1.png"):
            digest.update(b"\0" + path.encode() + b"\0" + (pictured.assets_path / path).read_bytes())
        assert document["manifestRevision"] == f"sha256:{digest.hexdigest()}"
        before = document["manifestRevision"]
        (pictured.assets_path / "ports" / "CN1.png").write_bytes(png(8, 2))
        assert hh.get("/device").json()["manifestRevision"] != before

        served = hh.get("/assets/appearance.svg")
        assert served.status_code == 200 and served.content == SVG
        assert served.headers["content-type"].startswith("image/svg+xml")
        assert served.headers["x-content-type-options"] == "nosniff"
        assert "default-src 'none'" in served.headers["content-security-policy"]
        assert hh.get("/assets/ports/CN1.png").content[:8] == b"\x89PNG\r\n\x1a\n"
        assert hh.get("/assets/appearance.svg", token="").status_code == 401
        assert hh.get("/assets/missing.svg").status_code == 404
        for bad in ("%2E%2E/secret.png", "ports/%2E%2E/%2E%2E/secret.png", "ports%5CCN1.png", "notes.txt"):
            assert hh.get(f"/assets/{bad}").status_code == 400, bad
    warnings: list[str] = []
    assert check_device(pictured, warnings=warnings) == []
    assert not any("image" in warning for warning in warnings)


def test_invalid_asset_references_fail_compliance(pictured):
    class Broken(pictured):
        appearance_image = "../outside.png"

        def pinout(self):
            image = ConnectorImage(asset="ports/CN1.png", mediaType="image/jpeg",
                                   pinPositions=(PinPosition(pinId="elsewhere.1", x=0, y=0),))
            return single_connector_pinout(self.hardware_id, self.manufacturer, self.model, 2, {}, "x", image=image)

    failures = check_device(Broken)
    assert any("appearance_image" in failure and ".." in failure for failure in failures)
    assert any("mediaType image/jpeg does not match image/png" in failure for failure in failures)
    assert any("pinPositions name pins not on this connector" in failure for failure in failures)


def test_resolve_asset_rules(tmp_path):
    (tmp_path / "a.svg").write_bytes(SVG)
    (tmp_path / "big.png").write_bytes(b"\0" * ((2 << 20) + 1))
    assert resolve_asset(tmp_path, "a.svg") == (tmp_path / "a.svg").resolve()
    for bad in ("", "/a.svg", "../a.svg", "./a.svg", "x/../a.svg", "a\\b.svg", "C:a.svg", "a.txt", "big.png"):
        with pytest.raises(AssetError):
            resolve_asset(tmp_path, bad)
    with pytest.raises(FileNotFoundError):
        resolve_asset(tmp_path, "gone.webp")
    assert image_size(png(3, 7), "image/png") == (3, 7)
    assert image_size(b'<svg width="10px" height="20">', "image/svg+xml") == (10, 20)


# --- leases -------------------------------------------------------------
HOLDER = {"terminalId": "term-1", "user": "alice", "host": "bench-pc", "label": "run 42"}


def test_lease_acquire_is_idempotent_per_terminal(hh):
    grant = hh.call("lease_acquire", holder=HOLDER)["data"]
    assert set(grant) == {"leaseId", "holder", "acquiredAt", "heartbeatIntervalMs", "timeoutMs"}
    assert grant["holder"] == HOLDER and grant["heartbeatIntervalMs"] == 2000 and grant["timeoutMs"] == 10_000
    again = hh.call("lease_acquire", holder="term-1")["data"]
    assert again["leaseId"] == grant["leaseId"] and again["holder"] == {"terminalId": "term-1"}
    status = hh.call("lease_status")["data"]
    assert status["held"] and status["holder"] == {"terminalId": "term-1"} and "leaseId" not in status
    assert set(status) == {"held", "holder", "acquiredAt", "lastHeartbeatAt"}
    busy = hh.call("lease_acquire", holder={"terminalId": "term-2", "user": "bob"})
    assert busy["error"]["category"] == "busy" and busy["error"]["details"]["holder"]["terminalId"] == "term-1"
    assert hh.call("lease_acquire", holder={"terminalId": "t", "extra": "x"})["ok"] is False


def test_lease_guards_configure_and_actuate(hh):
    lease_id = hh.call("lease_acquire", holder=HOLDER)["data"]["leaseId"]
    refused = hh.call("set_level", channel=0, level=True)
    assert refused["error"]["category"] == "busy" and refused["error"]["details"]["holder"] == HOLDER
    assert hh.service.device.levels[0] is False
    assert hh.call("set_level", {"leaseId": lease_id}, channel=0, level=True)["ok"]
    assert hh.call("read_level", channel=0)["ok"] and hh.call("safe_state")["ok"]
    beat = hh.call("lease_heartbeat", leaseId=lease_id)["data"]
    assert beat["leaseId"] == lease_id and beat["lastHeartbeatAt"] > 0
    assert hh.call("lease_heartbeat", leaseId="lease-other")["error"]["category"] == "busy"
    assert hh.call("lease_release", leaseId="lease-other")["error"]["category"] == "busy"
    assert hh.call("set_level", channel=0, level=True)["error"]["category"] == "busy"


def test_lease_release_and_force_release_drive_safe_state(hh):
    device = hh.service.device
    lease_id = hh.call("lease_acquire", holder=HOLDER)["data"]["leaseId"]
    hh.call("set_level", {"leaseId": lease_id}, channel=2, level=True)
    before = device.safe_calls
    ended = hh.call("lease_release", leaseId=lease_id)["data"]
    assert ended == {"held": False, "released": True, "holder": HOLDER,
                     "safeResult": [{"hardwareId": "DEMO1_1", "safeResult": {"safe": True}}]}
    assert device.safe_calls == before + 1 and device.levels == [False] * 4
    assert hh.call("lease_heartbeat", leaseId=lease_id)["error"]["category"] == "busy"
    stale = hh.call("set_level", {"leaseId": lease_id}, channel=0, level=True)
    assert stale["error"]["category"] == "busy"
    assert hh.call("lease_release", leaseId=lease_id)["data"] == {"held": False, "released": False}
    assert hh.call("set_level", channel=0, level=True)["ok"]  # a free device accepts calls without a lease

    hh.call("lease_acquire", holder=HOLDER)
    forced = hh.call("lease_force_release", reason="operator took over")["data"]
    assert forced["released"] and forced["holder"] == HOLDER and device.safe_calls == before + 2
    assert hh.call("lease_status")["data"] == {"held": False}
    assert hh.call("lease_force_release", reason="again")["data"] == {"held": False, "released": False}
    assert hh.call_raw("lease_force_release", reason="")["isError"] is True  # a reason is required


def test_lease_times_out_without_heartbeat_and_drives_safe_state(hh, monkeypatch):
    monkeypatch.setattr(lease_rules, "LEASE_TIMEOUT_MS", 300)
    device = hh.service.device
    grant = hh.call("lease_acquire", holder=HOLDER)["data"]
    assert grant["timeoutMs"] == 300
    hh.call("set_level", {"leaseId": grant["leaseId"]}, channel=3, level=True)
    for _ in range(6):  # any call carrying _meta.leaseId is a heartbeat
        time.sleep(0.1)
        assert hh.call("read_level", {"leaseId": grant["leaseId"]}, channel=3)["ok"]
    assert hh.call("lease_status")["data"]["held"] is True
    before = device.safe_calls
    deadline = time.monotonic() + 3
    while device.safe_calls == before and time.monotonic() < deadline:
        time.sleep(0.02)
    assert device.safe_calls == before + 1 and device.levels == [False] * 4
    assert hh.call("lease_status")["data"] == {"held": False}
    assert hh.call("lease_heartbeat", leaseId=grant["leaseId"])["error"]["category"] == "busy"
    assert hh.call("lease_acquire", holder="term-2")["ok"]
