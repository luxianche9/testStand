from __future__ import annotations

import time

import pytest
from starlette.testclient import WebSocketDenialResponse

from hardwareharness_device_sdk.testing import receive_until


def test_hello_then_live_batch(hh):
    with hh.websocket("do") as socket:
        hello = socket.receive_json()
        assert hello["type"] == "hello" and hello["streamId"] == "do" and hello["kind"] == "push"
        assert hello["hardwareId"] == hh.hardware_id and hello["cursor"] == hello["head"] == 0
        hh.call("set_level", channel=3, level=True)
        batch = receive_until(socket, lambda frame: frame["type"] == "batch")
        assert [item["value"] for item in batch["items"]] == [8] and batch["next"] == 1


def test_history_with_negative_cursor(hh):
    for channel in range(3):
        hh.call("set_level", channel=channel, level=True)
    with hh.websocket("do", cursor=-2) as socket:
        hello = socket.receive_json()
        assert hello["cursor"] == 1
        batch = receive_until(socket, lambda frame: frame["type"] == "batch")
        assert [item["seq"] for item in batch["items"]] == [1, 2]


def test_gap_when_resuming_evicted_cursor(hh):
    stream = hh.service.device.out
    for value in range(stream.buffer.capacity + 5):
        stream.publish(value)
    with hh.websocket("do", cursor=0) as socket:
        socket.receive_json()
        gap = socket.receive_json()
        assert gap == {"type": "gap", "from": 0, "to": 5, "reason": "overflow"}


def test_byte_stream_carries_tx(hh):
    with hh.websocket("serial1") as socket:
        assert socket.receive_json()["kind"] == "bytes"
        hh.call("write_text", text="hi\n")
        batch = receive_until(socket, lambda frame: frame["type"] == "batch")
        assert batch["items"][0] | {"seq": 0, "t": 0} == {"seq": 0, "t": 0, "dir": "tx", "bytes": 3,
                                                        "hex": "68 69 0a", "text": "hi\n"}


def test_sampled_stream_runs_only_while_watched(hh):
    device = hh.service.device
    device.inputs = 0b101
    assert device.di.describe()["state"] == "idle"
    with hh.websocket("di") as socket:
        socket.receive_json()
        batch = receive_until(socket, lambda frame: frame["type"] == "batch")
        assert batch["items"][0]["value"] == 5
        assert device.di.describe()["subscribers"] == 1
    deadline = time.monotonic() + 2
    while device.di.describe()["state"] != "idle" and time.monotonic() < deadline:
        time.sleep(0.02)
    assert device.di.describe()["state"] == "idle"
    head = device.di.buffer.head
    time.sleep(0.1)
    assert device.di.buffer.head == head


def test_not_configured_status_then_values(hh):
    with hh.websocket("ai0") as socket:
        socket.receive_json()
        status = receive_until(socket, lambda frame: frame["type"] == "status")
        assert status["state"] == "not_configured" and status["error"]["category"] == "not_configured"
        hh.call("configure")
        batch = receive_until(socket, lambda frame: frame["type"] == "batch", limit=500)
        assert batch["items"][0]["value"] == 1.25


def test_sampling_interleaves_with_tool_calls(hh):
    device = hh.service.device
    active = 0
    overlap = False
    original = device.read_level

    def guarded(*args, **kwargs):
        nonlocal active, overlap
        active += 1
        overlap = overlap or active > 1
        time.sleep(0.005)
        active -= 1
        return original(*args, **kwargs)
    device.di.sample = lambda: guarded(channel=0)["level"]
    with hh.websocket("di") as socket:
        socket.receive_json()
        for _ in range(10):
            assert hh.call("read_level", channel=0)["ok"]
    assert not overlap


def test_unknown_stream_closes_with_4404(hh):
    with hh.websocket("nope") as socket:
        frame = socket.receive_json()
        assert frame["type"] == "status" and frame["error"]["category"] == "invalid_argument"
        message = socket.receive()
        assert message["type"] == "websocket.close" and message["code"] == 4404


def test_wrong_token_is_denied(hh):
    with pytest.raises(WebSocketDenialResponse) as denied, hh.websocket("do", token="wrong"):
        pass
    assert denied.value.status_code == 401


def test_ping_pong(hh):
    with hh.websocket("do") as socket:
        socket.receive_json()
        socket.send_json({"type": "ping"})
        assert receive_until(socket, lambda frame: frame["type"] == "pong")
