from __future__ import annotations

import contextlib
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest

from teststand_backend.contracts.errors import AppError
from teststand_backend.streams import judge
from teststand_backend.streams.store import (
    StreamStore,
    check_keys,
    column_ms,
    record_end,
)
from teststand_backend.testing import TestEngine
from teststand_backend.testing.derived_views import DerivedViews


def scalar_store(path: Path, count: int = 10) -> StreamStore:
    store = StreamStore(path)
    store.set_meta(recording=True)
    key = store.add_stream("daq", "ai0")
    store.update_stream(key, stream_type="scalar", clock={"offsetMs": 100.0, "uncertaintyMs": 1.0})
    store.append(
        key,
        [
            {"seq": n, "t": 1000.0 + 10 * n, "tb": 900.0 + 10 * n, "v": float(n)}
            for n in range(count)
        ],
        watermark=1000.0 + 10 * count,
        watermark_tb=900.0 + 10 * count,
    )
    return store


def test_records_paging_and_time_range(tmp_path: Path) -> None:
    store = scalar_store(tmp_path / "s.sqlite")
    page = store.read("daq__ai0", limit=4)
    assert page["mode"] == "records" and [r["v"] for r in page["records"]] == [0, 1, 2, 3]
    assert page["records"][0] == {"i": 1, "seq": 0, "t": 1000.0, "tb": 900.0, "v": 0.0}
    rest = store.read("daq__ai0", after=page["next"], limit=100)
    assert [r["v"] for r in rest["records"]] == [4, 5, 6, 7, 8, 9] and rest["next"] is None
    ranged = store.read("daq__ai0", t0=920, t1=950)
    assert [r["v"] for r in ranged["records"]] == [2, 3, 4, 5]
    assert page["watermarkTb"] == 1000.0 and page["lastI"] == 10 and page["recording"] is True
    [entry] = store.streams()
    assert entry["count"] == 10 and entry["first"] == {"t": 1000.0, "tb": 900.0}
    assert entry["clock"] == {"offsetMs": 100.0, "uncertaintyMs": 1.0}
    with pytest.raises(Exception, match="No recorded stream"):
        store.read("nope")
    store.close()


def test_points_downsample_keeps_extremes(tmp_path: Path) -> None:
    store = StreamStore(tmp_path / "s.sqlite")
    key = store.add_stream("daq", "ai0")
    store.update_stream(key, stream_type="scalar")
    rows = [{"seq": n, "t": float(n), "tb": float(n), "v": 0.0} for n in range(1000)]
    rows[500]["v"], rows[501]["v"] = 9.0, -9.0
    store.append(key, rows)
    result = store.read(key, t0=0, t1=999, max_points=50)
    assert result["downsampled"] and len(result["points"]) <= 50 and result["count"] == 1000
    assert {point["v"] for point in result["points"]} >= {9.0, -9.0}
    store.close()


def test_block_records_expand_clip_and_overlap(tmp_path: Path) -> None:
    store = StreamStore(tmp_path / "s.sqlite")
    key = store.add_stream("scope", "ch1")
    store.update_stream(key, stream_type="block")
    block = {"seq": 0, "t": 100.0, "tb": 50.0, "t0": 100.0, "dt": 1.0, "samples": [0, 1, 2, 3, 4]}
    assert record_end(block) == 104.0
    store.append(key, [block])
    result = store.read(key, t0=52, t1=53, max_points=100)
    assert [(p["tb"], p["v"]) for p in result["points"]] == [(52.0, 2), (53.0, 3)]
    # a block that starts before the range but reaches into it is found
    assert [r["seq"] for r in store.records(key, 103, 110)] == [0]
    assert store.records(key, 105, 110) == []
    data = store.stream_data(key, 102, 104)
    assert data.records[0]["samples"] == [0, 1, 2, 3, 4] and "tb" not in data.records[0]
    store.close()


def test_bits_changes_only(tmp_path: Path) -> None:
    store = StreamStore(tmp_path / "s.sqlite")
    key = store.add_stream("dio", "di")
    store.update_stream(key, stream_type="bits")
    masks = [0, 0, 1, 1, 1, 3, 3]
    store.append(
        key, [{"seq": n, "t": float(n), "tb": float(n), "mask": m} for n, m in enumerate(masks)]
    )
    result = store.read(key, t0=0, t1=10, max_points=100)
    assert [(p["t"], p["mask"]) for p in result["points"]] == [(0, 0), (2, 1), (5, 3), (6, 3)]
    store.close()


def test_points_start_with_the_value_in_force(tmp_path: Path) -> None:
    store = StreamStore(tmp_path / "s.sqlite")
    bits = store.add_stream("dio", "di")
    store.update_stream(bits, stream_type="bits")
    store.append(bits, [{"seq": 0, "t": 0.0, "tb": 0.0, "mask": 5}])
    result = store.read(bits, t0=100, t1=200, max_points=100)
    assert result["count"] == 0 and [p["mask"] for p in result["points"]] == [5]
    scalar = scalar_store(tmp_path / "a.sqlite")
    ranged = scalar.read("daq__ai0", t0=925, t1=945, max_points=100)
    assert [(p["tb"], p["v"]) for p in ranged["points"]] == [
        (920.0, 2.0),
        (930.0, 3.0),
        (940.0, 4.0),
    ]
    assert ranged["count"] == 2
    exact = scalar.read("daq__ai0", t0=930, t1=945, max_points=100)
    assert [p["v"] for p in exact["points"]] == [3.0, 4.0]
    block = store.add_stream("scope", "ch1")
    store.update_stream(block, stream_type="block")
    store.append(
        block, [{"seq": 0, "t": 10.0, "tb": 10.0, "t0": 10.0, "dt": 1.0, "samples": [7, 8, 9]}]
    )
    tail = store.read(block, t0=20, t1=30, max_points=100)
    assert [(p["tb"], p["v"]) for p in tail["points"]] == [(12.0, 9)]
    scalar.close()
    store.close()


def test_stream_data_feeds_the_judge(tmp_path: Path) -> None:
    store = scalar_store(tmp_path / "s.sqlite")
    key = "daq__ai0"
    store.add_gap(
        key,
        {
            "reason": "overflow",
            "fromSeq": 20,
            "toSeq": 25,
            "t0": 1200.0,
            "t1": 1250.0,
            "tb": 1100.0,
        },
    )
    data = store.stream_data(key, 1020, 1060)
    assert data.stream_type == "scalar" and data.watermark == 1100.0
    assert data.records[0]["v"] == 0.0  # context before the window
    window = judge.Window(1020, 1060)
    verdict = judge.observe(
        data, window, [{"metric": "mean", "op": "within", "value": 4, "tolerance": 0.5}]
    )
    assert verdict["verdict"] == "pass", verdict
    assert store.gaps(key)[0]["tb1"] == 1150.0
    late = judge.observe(
        store.stream_data(key, 1080, 1200),
        judge.Window(1080, 1200),
        [{"metric": "mean", "op": "gt", "value": 0}],
    )
    assert late["reason"] == "watermark_timeout"
    store.close()


def test_states_blobs_and_readonly_reopen(tmp_path: Path) -> None:
    path = tmp_path / "s.sqlite"
    store = StreamStore(path)
    key = store.add_stream("cam", "shots")
    store.update_stream(key, stream_type="blob")
    store.add_state(key, 1.0, "connected")
    store.add_state(key, 2.0, "disconnected", "reset")
    store.append(key, [{"seq": 0, "t": 1.0, "tb": 1.0, "ref": "abc", "op": "op-1"}])
    info = store.put_blob(key, "abc", "image/png", b"\x89PNG")
    assert info["size"] == 4 and len(info["sha256"]) == 64
    store.set_meta(recording=False, stoppedTb=5.0)
    store.close()

    reopened = StreamStore(path, readonly=True)
    assert reopened.meta()["stoppedTb"] == 5.0 and reopened.meta()["version"] == 1
    page = reopened.read(key)
    assert page["records"][0]["op"] == "op-1" and page["blobs"]["abc"]["mime"] == "image/png"
    assert reopened.blob(key, "abc")["content"] == b"\x89PNG"
    assert [s["state"] for s in reopened.states(key)] == ["connected", "disconnected"]
    assert reopened.streams()[0]["states"] == ["connected", "disconnected"]
    reopened.close()
    with pytest.raises(Exception, match="No stream recording"):
        StreamStore(tmp_path / "missing.sqlite", readonly=True)


def test_window_downsamples_to_absolute_columns(tmp_path: Path) -> None:
    store = scalar_store(tmp_path / "s.sqlite", count=10)  # tb 900..990 step 10
    key = "daq__ai0"
    window = store.window(key, 920.0, 990.0, col_ms=40.0)
    assert window["colMs"] == 40.0 and window["lastI"] == 10 and window["state"] is None
    # Columns floor(tb / 40): 23 holds 920..950, 24 holds 960..990; min and max of each.
    assert [p["tb"] for p in window["points"]] == [920.0, 950.0, 960.0, 990.0]

    held = store.window(key, 925.0, 935.0, col_ms=1.0)
    assert [p["tb"] for p in held["points"]] == [920.0, 930.0]
    assert [p["tb"] for p in store.window(key, 925.0, 935.0, col_ms=1.0, held=False)["points"]] == [
        930.0
    ]
    head = store.head(key, 900.0, None, col_ms=1.0)
    assert "points" not in head and head["watermarkTb"] == 1000.0
    assert store.earliest_after(key, 7) == 970.0 and store.earliest_after(key, 10) is None
    version = store.version(key)
    assert version is not None and version[:3] == ("scalar", 1000.0, 10)
    assert store.version("daq__missing") is None

    store.add_state(key, 995.0, "disconnected", "gone")
    assert store.version(key) != version
    assert store.window(key, 900.0, None, col_ms=10.0)["state"]["state"] == "disconnected"

    store.prune(955.0)
    assert [p["tb"] for p in store.window(key, 900.0, None, col_ms=1.0)["points"]] == [
        960.0,
        970.0,
        980.0,
        990.0,
    ]
    store.close()


def test_window_pages_record_streams(tmp_path: Path) -> None:
    store = StreamStore(tmp_path / "r.sqlite")
    key = store.add_stream("dut", "uart")
    store.update_stream(key, stream_type="bytes")
    store.append(
        key,
        [{"seq": n, "t": 10.0 * n, "tb": 10.0 * n, "dir": "rx", "data": "41"} for n in range(5)],
    )
    page = store.window(key, 0.0, None, col_ms=1.0, limit=3)
    assert [r["i"] for r in page["records"]] == [1, 2, 3] and page["next"] == 3
    rest = store.window(key, 0.0, None, col_ms=1.0, after=page["next"])
    assert [r["i"] for r in rest["records"]] == [4, 5] and rest["next"] is None
    assert "points" not in rest
    store.close()


def test_column_and_key_limits() -> None:
    assert column_ms(1000.0, 500) == 2.0
    for span, width in [(0.0, 10), (100.0, 0), (100.0, 10_000)]:
        with pytest.raises(AppError):
            column_ms(span, width)
    assert check_keys(["a__b", "a__b", "c__d"]) == ["a__b", "c__d"]
    with pytest.raises(AppError):
        check_keys([])


def test_run_stream_window_checks_the_recording(tmp_path: Path) -> None:
    store = scalar_store(tmp_path / "s.sqlite")

    @contextlib.contextmanager
    def recording(run_id: str) -> Iterator[StreamStore | None]:
        yield store if run_id == "run-1" else None

    engine = SimpleNamespace(_stream_store=recording, derived_views=DerivedViews())
    window = TestEngine.stream_window(engine, "run-1", ["daq__ai0"], 900.0, 1000.0, 10)  # type: ignore[arg-type]
    assert window["colMs"] == 10.0 and window["recording"] is True
    assert len(window["streams"]["daq__ai0"]["points"]) == 10
    for run_id, keys in [("run-1", ["daq__missing"]), ("run-2", ["daq__ai0"])]:
        with pytest.raises(AppError) as error:
            TestEngine.stream_window(engine, run_id, keys, 900.0, 1000.0, 10)  # type: ignore[arg-type]
        assert error.value.category == "not_found"
    store.close()


def test_record_ids_keep_increasing_after_the_cache_is_emptied(tmp_path: Path) -> None:
    store = StreamStore(tmp_path / "s.sqlite")
    key = store.add_stream("dut", "uart")
    store.update_stream(key, stream_type="bytes")
    store.append(
        key, [{"seq": n, "t": 1000.0 + n, "tb": 1000.0 + n, "data": "00"} for n in range(5)]
    )
    after = store.read(key, after=None)["records"][-1]["i"]
    store.prune(10_000.0)
    assert store.records(key) == []
    store.append(key, [{"seq": 5, "t": 20_000.0, "tb": 20_000.0, "data": "4f4b"}])
    assert [r["data"] for r in store.read(key, after=after)["records"]] == ["4f4b"]
    store.close()


def test_payload_never_overrides_the_record_identity(tmp_path: Path) -> None:
    store = StreamStore(tmp_path / "s.sqlite")
    key = store.add_stream("daq", "ai0")
    store.update_stream(key, stream_type="scalar")
    [i] = store.append(key, [{"i": 6, "seq": 0, "t": 1.0, "tb": 1.0, "v": 1.0}])
    [record] = store.records(key)
    assert record["i"] == i == store.last_i(key) == 1
    store.close()


def test_stream_data_carries_the_stored_declaration(tmp_path: Path) -> None:
    store = scalar_store(tmp_path / "s.sqlite")
    store.update_stream("daq__ai0", declaration={"kind": "setpoint", "unit": "V"})
    data = store.stream_data("daq__ai0", 1000.0, 1090.0)
    assert data.descriptor == {"kind": "setpoint", "unit": "V"}
    assert judge.evidence_type(data.stream_type, data.descriptor) == "S"
    store.close()
