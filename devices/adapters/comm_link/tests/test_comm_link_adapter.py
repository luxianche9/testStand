from __future__ import annotations

import socket
import threading
import time
from collections.abc import Iterator
from typing import Any

import pytest
from teststand_device_sdk.testing import check_device, dry_run_config, serve

from teststand_adapter_comm_link import DEVICE, CommLink

PUBLIC_TOOLS = {
    "get_device_info", "list_hardware", "get_hardware_info", "self_test",
    "link_open_serial", "link_connect_tcp", "link_listen_tcp", "link_open_udp", "link_disconnect",
    "link_write_text", "link_write_hex", "link_read_rx", "link_clear_rx", "link_link_status",
    "link_list_serial_ports", "link_safe_state", "link_stream_read", "link_transact",
}


def settings(**values: Any):
    return dry_run_config(CommLink, settings=values)


def records(hh: Any, *, direction: str | None = None) -> list[dict[str, Any]]:
    read = hh.call("stream_read", streamId="link", fromSeq=0, limit=500)["data"]["records"]
    return [record for record in read if direction is None or record["dir"] == direction]


def wait_for(predicate: Any, timeout: float = 5.0) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("condition not reached")


def rx_bytes(hh: Any) -> bytes:
    return b"".join(bytes.fromhex(record["data"]) for record in records(hh, direction="rx"))


def marks(hh: Any) -> list[str]:
    return [record.get("note", "") for record in records(hh, direction="mark")]


@pytest.fixture
def hh():
    with serve(CommLink) as harness:
        yield harness


@pytest.fixture
def echo_server() -> Iterator[tuple[int, threading.Event]]:
    """A TCP server on localhost that echoes; set the event to drop the current client."""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(4)
    server.settimeout(0.1)
    drop, stop = threading.Event(), threading.Event()

    def serve_clients() -> None:
        while not stop.is_set():
            try:
                client, _ = server.accept()
            except TimeoutError:
                continue
            client.settimeout(0.05)
            with client:
                while not stop.is_set() and not drop.is_set():
                    try:
                        data = client.recv(4096)
                    except TimeoutError:
                        continue
                    if not data:
                        break
                    client.sendall(data)
            drop.clear()

    thread = threading.Thread(target=serve_clients, daemon=True)
    thread.start()
    yield server.getsockname()[1], drop
    stop.set()
    thread.join(2)
    server.close()


def test_entry_point_and_compliance():
    assert DEVICE is CommLink
    warnings: list[str] = []
    assert check_device(CommLink, warnings=warnings) == []
    assert [item for item in warnings if "pinout" not in item] == []


def test_public_contract(hh):
    internal = {name for name, item in hh.tools.items() if item["_meta"]["teststand"]["kind"] == "internal"}
    assert set(hh.tools) - internal == PUBLIC_TOOLS
    semantics = hh.tools["link_write_hex"]["_meta"]["teststand"]["operationSemantics"]
    assert semantics["kind"] == "actuate" and semantics["retry"] == "never_after_dispatch"
    assert semantics["stateRequirements"] == []  # a link made from settings needs no tool call first
    port = hh.tools["link_connect_tcp"]["inputSchema"]["properties"]["port"]
    assert (port["minimum"], port["maximum"]) == (1, 65535)
    assert hh.device()["streams"] == [{"id": "link", "type": "bytes", "label": "通信链路", "writable": True}]


def test_without_a_link_nothing_is_sent(hh):
    assert hh.call("link_status")["data"] == {"link": "none", "connected": False, "address": {}, "label": "未连接"}
    result = hh.call_raw("link_write_text", {"hardwareId": hh.hardware_id, "text": "hi"})
    assert result["ok"] is False and result["error"]["category"] == "not_configured"


@pytest.mark.parametrize(("tool", "arguments"), [
    ("link_connect_tcp", {"host": "127.0.0.1", "port": 70000}),
    ("link_open_serial", {"port": "/dev/ttyS0"}),
    ("link_open_serial", {"port": "COM3", "baudrate": 10}),
    ("link_open_udp", {"host": "127.0.0.1"}),
])
def test_bad_arguments_are_refused_before_anything_opens(hh, tool, arguments):
    result = hh.call_raw(tool, {"hardwareId": hh.hardware_id, **arguments})
    assert result["ok"] is False and result["error"]["category"] == "invalid_argument"
    assert hh.call("link_status")["data"]["link"] == "none"


def test_serial_settings_open_the_port_and_traffic_is_on_the_stream():
    config = settings(link="serial", port="com7", baudrate=115200)
    with serve(CommLink, config) as hh:
        status = hh.call("link_status")["data"]
        assert status["link"] == "serial" and status["label"] == "COM7 115200 8N1"
        assert hh.device()["streams"][0]["label"] == "COM7 115200"
        sent = hh.call("write_hex", operation_id="op-1", hex="AA 55 01")
        assert sent["data"] == {"bytes": 3}
        wait_for(lambda: rx_bytes(hh) == b"\xaa\x55\x01")  # the dry-run port loops TX back
        tx = records(hh, direction="tx")
        assert tx[-1]["data"] == "aa5501" and tx[-1]["op"] == "op-1"
        assert hh.call("read_rx")["data"]["hex"] == "aa 55 01"
        hh.call("clear_rx")
        assert hh.call("read_rx")["data"]["bytes"] == 0
        assert hh.call("safe_state")["data"] == {"flushed": True}
        assert marks(hh)[0] == "connect COM7 115200 8N1"


def test_serial_tool_replaces_the_link():
    with serve(CommLink) as hh:
        info = hh.call("open_serial", port="COM4", baudrate=9600, parity="E", stopbits=2)["data"]
        assert info["label"] == "COM4 9600 8E2" and info["connected"] is True
        hh.call("write_text", text="ping\r\n")
        wait_for(lambda: rx_bytes(hh) == b"ping\r\n")
        assert hh.call("disconnect")["data"]["link"] == "none"


def test_tcp_client_reconnects_after_the_server_drops_it(echo_server):
    port, drop = echo_server
    with serve(CommLink, settings(link="tcp_client", host="127.0.0.1", port=port)) as hh:
        hh.call("write_text", text="hello")
        wait_for(lambda: rx_bytes(hh) == b"hello")
        drop.set()
        wait_for(lambda: any(note.startswith("disconnected") for note in marks(hh)))
        wait_for(lambda: any(note.startswith("reconnected") for note in marks(hh)), timeout=8)
        hh.call("write_text", text="again")
        wait_for(lambda: rx_bytes(hh) == b"helloagain")


def test_tcp_server_takes_one_client_and_marks_it():
    with serve(CommLink, settings(link="tcp_server", port=0, bind="127.0.0.1")) as hh:
        port = hh.call("link_status")["data"]["address"]["port"]
        refused = hh.call_raw("link_write_text", {"hardwareId": hh.hardware_id, "text": "x"})
        assert refused["error"]["category"] == "not_configured"
        with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
            client.sendall(b"\x01\x02")
            wait_for(lambda: rx_bytes(hh) == b"\x01\x02")
            assert any(note.endswith("connected") for note in marks(hh))
            hh.call("write_hex", hex="03 04")
            assert client.recv(16) == b"\x03\x04"
        wait_for(lambda: any(note.endswith("disconnected") for note in marks(hh)))


def test_udp_replies_to_the_last_sender():
    with serve(CommLink) as hh:
        info = hh.call("open_udp", local_port=0)["data"]
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as peer:
            peer.bind(("127.0.0.1", 0))
            peer.settimeout(2)
            refused = hh.call_raw("link_write_text", {"hardwareId": hh.hardware_id, "text": "x"})
            assert refused["error"]["category"] == "not_configured"
            peer.sendto(b"temp=25.3\n", ("127.0.0.1", info["address"]["localPort"]))
            wait_for(lambda: rx_bytes(hh) == b"temp=25.3\n")
            hh.call("write_text", text="ok")
            assert peer.recv(16) == b"ok"
            assert hh.call("link_status")["data"]["address"]["lastPeer"] == f"127.0.0.1:{peer.getsockname()[1]}"


def test_incomplete_settings_keep_the_device_closed_and_say_why():
    with serve(CommLink, settings(link="tcp_client", host="127.0.0.1")) as hh:
        [hardware] = hh.call("list_hardware")["data"]
        assert hardware["state"] != "open"
        assert "incomplete" in hardware["lastError"]["message"]


def test_self_test_reports_the_link():
    with serve(CommLink, settings(link="serial", port="COM9")) as hh:
        result = hh.call("self_test")["data"]
        assert result["passed"] is True
        assert [check["name"] for check in result["checks"]] == ["链路已配置", "链路已建立"]
