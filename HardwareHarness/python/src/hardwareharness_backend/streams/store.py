"""StreamStore: one SQLite database of recorded device streams (design §5.4).

A run records into ``runs/<runId>/run.sqlite``, next to its journal; the live hub
records each followed stream into a temporary database with the same layout. The recorder
is the only writer (one connection, one transaction per batch); readers query
the same connection on the event loop.

Times: ``t``/``tEnd`` are service time (the stream's clock domain, what the judge
uses), ``tb`` is backend time (what the UI timeline uses). ``tEnd`` is the last
sample time of a ``block`` record and equals ``t`` otherwise.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import math
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any

from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.util import Record

from .data import StreamData, stream_key

VERSION = 1
NUMERIC_TYPES = {"scalar", "block"}
SAMPLED_TYPES = NUMERIC_TYPES | {"bits"}
DEFAULT_LIMIT = 1000
MAX_LIMIT = 10_000
MAX_POINTS = 20_000
MAX_WIDTH = 8192
"""Widest display a window is downsampled for, in pixel columns."""
MAX_KEYS = 64
CONTEXT_RECORDS = 16
"""Records before a judged window: the held ``bits`` state and the sample interval."""

_COLUMNS = ("i", "key", "seq", "t", "tEnd", "tb", "op", "data")
_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS streams(
  key TEXT PRIMARY KEY, hardwareId TEXT, streamId TEXT, type TEXT, clock TEXT,
  count INTEGER NOT NULL DEFAULT 0, watermark REAL, watermarkTb REAL,
  maxSpan REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS records(
  i INTEGER PRIMARY KEY, key TEXT NOT NULL, seq INTEGER, t REAL NOT NULL, tEnd REAL NOT NULL,
  tb REAL NOT NULL, op TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS records_key_t ON records(key, t);
CREATE INDEX IF NOT EXISTS records_key_tb ON records(key, tb);
CREATE TABLE IF NOT EXISTS gaps(
  key TEXT, reason TEXT, fromSeq INTEGER, toSeq INTEGER, t0 REAL, t1 REAL, tb REAL);
CREATE TABLE IF NOT EXISTS states(key TEXT, tb REAL, state TEXT, message TEXT);
CREATE TABLE IF NOT EXISTS blobs(
  ref TEXT, key TEXT, mime TEXT, size INTEGER, sha256 TEXT, content BLOB,
  PRIMARY KEY(key, ref));
"""


def record_end(record: Record) -> float:
    """Service time of the last sample of a record (``block`` spans ``samples``)."""
    t = float(record["t"])
    if "samples" in record and "t0" in record and "dt" in record:
        count = len(record["samples"])
        return max(t, float(record["t0"]) + max(0, count - 1) * float(record["dt"]))
    return t


def read_query(query: Record) -> Record:
    """``{t0, t1, maxPoints, after, limit}`` from the wire to :meth:`StreamStore.read`."""
    names = {"t0": "t0", "t1": "t1", "maxPoints": "max_points", "after": "after", "limit": "limit"}
    return {name: query[wire] for wire, name in names.items() if query.get(wire) is not None}


def column_ms(span_ms: float, width: int) -> float:
    """Width of one display column: ``span_ms`` shown on ``width`` pixel columns."""
    if not 1 <= int(width) <= MAX_WIDTH:
        raise app_error("invalid_argument", f"width must be in [1, {MAX_WIDTH}]", {"width": width})
    if not span_ms > 0:
        raise app_error("invalid_argument", "The window must be longer than 0 ms", {"ms": span_ms})
    return float(span_ms) / int(width)


def check_keys(keys: list[str]) -> list[str]:
    unique = list(dict.fromkeys(keys))
    if not 1 <= len(unique) <= MAX_KEYS:
        raise app_error("invalid_argument", f"Give 1 to {MAX_KEYS} stream keys", {"keys": keys})
    return unique


class StreamStore:
    def __init__(self, path: Path, *, readonly: bool = False) -> None:
        self.path = path
        self.readonly = readonly
        if readonly:
            if not path.exists():
                raise app_error("not_found", f"No stream recording at {path}", {"path": str(path)})
            self.db = sqlite3.connect(
                f"file:{path.as_posix()}?mode=ro", uri=True, check_same_thread=False
            )
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            self.db = sqlite3.connect(path, check_same_thread=False)
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=NORMAL")
            self.db.executescript(_SCHEMA)
            with self.db:
                self.db.execute(
                    "INSERT OR IGNORE INTO meta VALUES ('version', ?)", (json.dumps(VERSION),)
                )
        self.db.row_factory = sqlite3.Row
        self._waiters: list[asyncio.Future[None]] = []
        self.closed = False

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self._wake()
        self.db.close()

    # -- writing -----------------------------------------------------------------------------

    def set_meta(self, **values: Any) -> None:
        with self.db:
            self.db.executemany(
                "INSERT INTO meta VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                [(key, json.dumps(value)) for key, value in values.items()],
            )
        self._wake()

    def add_stream(self, hardware_id: str, stream_id: str) -> str:
        key = stream_key(hardware_id, stream_id)
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO streams(key, hardwareId, streamId) VALUES (?, ?, ?)",
                (key, hardware_id, stream_id),
            )
        return key

    def update_stream(
        self,
        key: str,
        *,
        stream_type: str | None = None,
        clock: Record | None = None,
        watermark: float | None = None,
        watermark_tb: float | None = None,
    ) -> None:
        sets: list[str] = []
        values: list[Any] = []
        if stream_type is not None:
            sets.append("type = ?")
            values.append(stream_type)
        if clock is not None:
            sets.append("clock = ?")
            values.append(json.dumps(clock))
        if watermark is not None:
            sets.append("watermark = MAX(COALESCE(watermark, ?), ?)")
            values += [watermark, watermark]
        if watermark_tb is not None:
            sets.append("watermarkTb = MAX(COALESCE(watermarkTb, ?), ?)")
            values += [watermark_tb, watermark_tb]
        if not sets:
            return
        with self.db:
            self.db.execute(f"UPDATE streams SET {', '.join(sets)} WHERE key = ?", (*values, key))
        self._wake()

    def append(
        self,
        key: str,
        records: list[Record],
        *,
        watermark: float | None = None,
        watermark_tb: float | None = None,
    ) -> list[int]:
        """Insert one batch (records carry ``seq, t, tb, op?`` plus payload); returns ``i``."""
        rows: list[tuple[Any, ...]] = []
        span = 0.0
        for record in records:
            t, end = float(record["t"]), record_end(record)
            span = max(span, end - t)
            payload = {k: v for k, v in record.items() if k not in {"seq", "t", "tb", "op"}}
            rows.append(
                (
                    key,
                    record.get("seq"),
                    t,
                    end,
                    float(record["tb"]),
                    record.get("op"),
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                )
            )
        ids: list[int] = []
        with self.db:
            for row in rows:
                cursor = self.db.execute(
                    "INSERT INTO records(key, seq, t, tEnd, tb, op, data) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    row,
                )
                assert cursor.lastrowid is not None
                ids.append(cursor.lastrowid)
            self.db.execute(
                "UPDATE streams SET count = count + ?, maxSpan = MAX(maxSpan, ?), "
                "watermark = CASE WHEN ? IS NULL THEN watermark "
                "  ELSE MAX(COALESCE(watermark, ?), ?) END, "
                "watermarkTb = CASE WHEN ? IS NULL THEN watermarkTb "
                "  ELSE MAX(COALESCE(watermarkTb, ?), ?) END "
                "WHERE key = ?",
                (
                    len(rows),
                    span,
                    watermark,
                    watermark,
                    watermark,
                    watermark_tb,
                    watermark_tb,
                    watermark_tb,
                    key,
                ),
            )
        self._wake()
        return ids

    def add_gap(self, key: str, gap: Record) -> None:
        with self.db:
            self.db.execute(
                "INSERT INTO gaps VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    key,
                    gap.get("reason"),
                    gap.get("fromSeq"),
                    gap.get("toSeq"),
                    gap.get("t0"),
                    gap.get("t1"),
                    gap.get("tb"),
                ),
            )
        self._wake()

    def add_state(self, key: str, tb: float, state: str, message: str | None = None) -> None:
        with self.db:
            self.db.execute("INSERT INTO states VALUES (?, ?, ?, ?)", (key, tb, state, message))
        self._wake()

    def put_blob(self, key: str, ref: str, mime: str, content: bytes) -> Record:
        digest = hashlib.sha256(content).hexdigest()
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO blobs VALUES (?, ?, ?, ?, ?, ?)",
                (ref, key, mime, len(content), digest, content),
            )
        return {"ref": ref, "mime": mime, "size": len(content), "sha256": digest}

    # -- change notification -------------------------------------------------------------------

    def _wake(self) -> None:
        waiters, self._waiters = self._waiters, []
        for waiter in waiters:
            if not waiter.done():
                waiter.set_result(None)

    async def wait_change(self, timeout: float) -> None:
        """Return after the next commit (or ``timeout`` seconds)."""
        if self.closed or timeout <= 0:
            return
        waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._waiters.append(waiter)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(waiter, timeout)

    # -- reading ---------------------------------------------------------------------------------

    def meta(self) -> Record:
        return {row["k"]: json.loads(row["v"]) for row in self.db.execute("SELECT k, v FROM meta")}

    @property
    def recording(self) -> bool:
        return bool(self.meta().get("recording"))

    def streams(self) -> list[Record]:
        """Recording index: one entry per stream with counts, extent, gaps and states."""
        result: list[Record] = []
        for row in self.db.execute("SELECT * FROM streams ORDER BY rowid"):
            key = row["key"]
            extent = self.db.execute(
                "SELECT MIN(t), MIN(tb), MAX(tEnd), MAX(tb + tEnd - t), MAX(i) FROM records "
                "WHERE key = ?",
                (key,),
            ).fetchone()
            states = [
                r[0]
                for r in self.db.execute(
                    "SELECT DISTINCT state FROM states WHERE key = ? ORDER BY state", (key,)
                )
            ]
            gaps = self.db.execute("SELECT COUNT(*) FROM gaps WHERE key = ?", (key,)).fetchone()
            result.append(
                {
                    "key": key,
                    "hardwareId": row["hardwareId"],
                    "streamId": row["streamId"],
                    "type": row["type"],
                    "clock": _json(row["clock"]),
                    "count": row["count"],
                    "first": None if extent[0] is None else {"t": extent[0], "tb": extent[1]},
                    "last": None if extent[2] is None else {"t": extent[2], "tb": extent[3]},
                    "lastI": extent[4],
                    "watermark": row["watermark"],
                    "watermarkTb": row["watermarkTb"],
                    "gaps": gaps[0],
                    "states": states,
                }
            )
        return result

    def stream(self, key: str) -> Record:
        row = self.db.execute("SELECT * FROM streams WHERE key = ?", (key,)).fetchone()
        if row is None:
            raise app_error("not_found", f"No recorded stream {key}", {"key": key})
        return {
            "key": key,
            "hardwareId": row["hardwareId"],
            "streamId": row["streamId"],
            "type": row["type"],
            "clock": _json(row["clock"]),
            "count": row["count"],
            "watermark": row["watermark"],
            "watermarkTb": row["watermarkTb"],
            "maxSpan": row["maxSpan"],
        }

    def gaps(self, key: str) -> list[Record]:
        rows = self.db.execute(
            "SELECT reason, fromSeq, toSeq, t0, t1, tb FROM gaps WHERE key = ? ORDER BY rowid",
            (key,),
        )
        result: list[Record] = []
        for row in rows:
            gap = dict(row)
            if gap["tb"] is not None and gap["t0"] is not None and gap["t1"] is not None:
                gap["tb1"] = round(gap["tb"] + gap["t1"] - gap["t0"], 3)
            result.append(gap)
        return result

    def states(self, key: str) -> list[Record]:
        rows = self.db.execute(
            "SELECT tb, state, message FROM states WHERE key = ? ORDER BY rowid", (key,)
        )
        return [dict(row) for row in rows]

    def blob(self, key: str, ref: str) -> Record:
        row = self.db.execute(
            "SELECT * FROM blobs WHERE key = ? AND ref = ?", (key, ref)
        ).fetchone()
        if row is None:
            raise app_error("not_found", f"No stored blob {ref}", {"key": key, "ref": ref})
        return dict(row)

    def records(
        self,
        key: str,
        lo: float | None = None,
        hi: float | None = None,
        *,
        domain: str = "t",
        after: int | None = None,
        limit: int | None = None,
    ) -> list[Record]:
        """Records overlapping ``[lo, hi]`` in ``t`` (service) or ``tb`` (backend), by ``i``."""
        assert domain in {"t", "tb"}
        where = ["key = ?"]
        values: list[Any] = [key]
        if hi is not None:
            where.append(f"{domain} <= ?")
            values.append(hi)
        if lo is not None:
            span = self.stream(key)["maxSpan"]
            where.append(f"{domain} >= ? AND {domain} + tEnd - t >= ?")
            values += [lo - span, lo]
        if after is not None:
            where.append("i > ?")
            values.append(after)
        sql = f"SELECT {', '.join(_COLUMNS)} FROM records WHERE {' AND '.join(where)} ORDER BY i"
        if limit is not None:
            sql += f" LIMIT {int(limit)}"
        return [_row(row) for row in self.db.execute(sql, values)]

    def last_i(self, key: str) -> int | None:
        row = self.db.execute("SELECT MAX(i) FROM records WHERE key = ?", (key,)).fetchone()
        return None if row[0] is None else int(row[0])

    def version(self, key: str) -> tuple[Any, ...] | None:
        """``(type, watermarkTb, lastI, gaps, states)``: changes whenever the stream does;
        ``None`` before the stream is added."""
        row = self.db.execute(
            "SELECT type, watermarkTb, (SELECT MAX(i) FROM records WHERE key = ?1), "
            "(SELECT COUNT(*) FROM gaps WHERE key = ?1), "
            "(SELECT COUNT(*) FROM states WHERE key = ?1) FROM streams WHERE key = ?1",
            (key,),
        ).fetchone()
        return None if row is None else tuple(row)

    def stream_data(self, key: str, t0: float, t1: float) -> StreamData:
        """Judge input for service window ``[t0, t1]``: the window plus context before it."""
        info = self.stream(key)
        columns = ", ".join(_COLUMNS)
        before = [
            _row(row)
            for row in self.db.execute(
                f"SELECT {columns} FROM records WHERE key = ? AND t < ? ORDER BY t DESC LIMIT ?",
                (key, t0, CONTEXT_RECORDS),
            )
        ]
        inside = [
            _row(row)
            for row in self.db.execute(
                f"SELECT {columns} FROM records WHERE key = ? AND t >= ? AND t <= ? ORDER BY t, i",
                (key, t0, t1),
            )
        ]
        records = before[::-1] + inside
        return StreamData(
            stream_type=str(info["type"] or ""),
            records=[_judge_record(r) for r in records],
            gaps=self.gaps(key),
            watermark=info["watermark"],
            clock=info["clock"] or {},
        )

    def read(
        self,
        key: str,
        *,
        t0: float | None = None,
        t1: float | None = None,
        max_points: int | None = None,
        after: int | None = None,
        limit: int | None = None,
    ) -> Record:
        """One stream for display, in backend time.

        * ``maxPoints`` on a sampled stream (``scalar``/``block``/``bits``): points in
          ``[t0, t1]``, min/max downsampled (``bits``: changes only).
        * Otherwise records by ``i`` (``after`` = last seen ``i``) up to ``limit``, with
          ``next`` when more are waiting.
        """
        info = self.stream(key)
        stream_type = str(info["type"] or "")
        lo, hi = t0, t1
        if lo is None or hi is None:
            extent = self.db.execute(
                "SELECT MIN(tb), MAX(tb + tEnd - t) FROM records WHERE key = ?", (key,)
            ).fetchone()
            lo = extent[0] if lo is None else lo
            hi = (info["watermarkTb"] or extent[1]) if hi is None else hi
        base: Record = {
            "key": key,
            "type": stream_type,
            "t0": lo,
            "t1": hi,
            "watermarkTb": info["watermarkTb"],
            "clock": info["clock"],
            "lastI": self.last_i(key),
            "recording": self.recording,
            "gaps": [
                gap
                for gap in self.gaps(key)
                if (hi is None or (gap.get("tb") or 0) <= hi)
                and (lo is None or (gap.get("tb1") or gap.get("tb") or 0) >= lo)
            ],
        }
        if max_points is not None and stream_type in SAMPLED_TYPES:
            budget = max(2, min(int(max_points), MAX_POINTS))
            rows = [_slim(row) for row in self.records(key, lo, hi, domain="tb")]
            if stream_type == "bits":
                changes = bit_changes(rows, budget)
                return {
                    **base,
                    "mode": "points",
                    "count": len(rows),
                    "points": self._in_force(key, lo, stream_type, changes) + changes,
                }
            expanded = [
                point
                for point in points(rows, stream_type)
                if (lo is None or point["tb"] >= lo) and (hi is None or point["tb"] <= hi)
            ]
            prior = self._in_force(key, lo, stream_type, expanded)
            if lo is None or hi is None or not expanded:
                return {
                    **base,
                    "mode": "points",
                    "count": len(expanded),
                    "points": prior + expanded[:budget],
                }
            return {
                **base,
                "mode": "points",
                "count": len(expanded),
                "points": prior + downsample(expanded, lo, hi, budget),
                "downsampled": len(expanded) > budget,
            }
        size = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
        selected = self.records(key, t0, t1, domain="tb", after=after, limit=size + 1)
        more = len(selected) > size
        selected = selected[:size]
        blobs = self._blob_index(key) if stream_type == "blob" else {}
        return {
            **base,
            "mode": "records",
            "records": selected,
            "next": selected[-1]["i"] if more else None,
            **({"blobs": blobs} if blobs else {}),
        }

    def _in_force(
        self, key: str, lo: float | None, stream_type: str, shown: list[Record]
    ) -> list[Record]:
        """The last point before ``lo`` when none sits at ``lo``: the value in force at ``lo``.

        A level stream (a DI mask, a slow setpoint) changes rarely, so a window after its last
        change would otherwise read as empty.
        """
        if lo is None or (shown and shown[0]["tb"] <= lo):
            return []
        row = self.db.execute(
            f"SELECT {', '.join(_COLUMNS)} FROM records WHERE key = ? AND tb < ? "
            "ORDER BY tb DESC, i DESC LIMIT 1",
            (key, lo),
        ).fetchone()
        if row is None:
            return []
        before = [point for point in points([_slim(_row(row))], stream_type) if point["tb"] < lo]
        return before[-1:]

    def head(self, key: str, t0: float, t1: float | None, *, col_ms: float) -> Record:
        """A :meth:`window` without its data: type, watermark, last ``i``, the gaps overlapping
        ``[t0, t1]`` and the latest connection state."""
        info = self.stream(key)
        states = self.states(key)
        return {
            "key": key,
            "type": str(info["type"] or ""),
            "t0": t0,
            "t1": t1,
            "colMs": col_ms,
            "watermarkTb": info["watermarkTb"],
            "lastI": self.last_i(key),
            "gaps": [
                gap
                for gap in self.gaps(key)
                if (t1 is None or (gap.get("tb") or 0) <= t1)
                and (gap.get("tb1") or gap.get("tb") or 0) >= t0
            ],
            "state": states[-1] if states else None,
        }

    def earliest_after(self, key: str, after: int | None) -> float | None:
        """Earliest backend time among the records after ``i`` ``after``."""
        row = self.db.execute(
            "SELECT MIN(tb) FROM records WHERE key = ? AND i > ?", (key, after or 0)
        ).fetchone()
        return None if row[0] is None else float(row[0])

    def window(
        self,
        key: str,
        t0: float,
        t1: float | None,
        *,
        col_ms: float,
        held: bool = True,
        after: int | None = None,
        limit: int = MAX_LIMIT,
    ) -> Record:
        """One stream for a display whose pixel columns are ``col_ms`` wide (design doc 5.9.3).

        Sampled streams (``scalar``/``block``/``bits``): ``points`` in backend time ``[t0, t1]``
        (``t1=None``: up to the newest), min/max per column of the absolute grid
        ``floor(tb / col_ms)`` (``bits``: its changes); ``held`` puts the point in force at
        ``t0`` first. Other streams: ``records`` overlapping the window, only those after ``i``
        ``after`` when given, up to ``limit`` with ``next`` when more are waiting.
        """
        base = self.head(key, t0, t1, col_ms=col_ms)
        stream_type = base["type"]
        if stream_type in SAMPLED_TYPES:
            rows = [_slim(row) for row in self.records(key, t0, t1, domain="tb")]
            if stream_type == "bits":
                shown = bit_changes(rows, MAX_POINTS)
            else:
                shown = columns(
                    [
                        point
                        for point in points(rows, stream_type)
                        if point["tb"] >= t0 and (t1 is None or point["tb"] <= t1)
                    ],
                    col_ms,
                )
            prior = self._in_force(key, t0, stream_type, shown) if held else []
            return {**base, "points": prior + shown}
        size = max(1, min(int(limit), MAX_LIMIT))
        selected = self.records(key, t0, t1, domain="tb", after=after, limit=size + 1)
        more = len(selected) > size
        selected = selected[:size]
        blobs = self._blob_index(key) if stream_type == "blob" else {}
        return {
            **base,
            "records": selected,
            "next": selected[-1]["i"] if more else None,
            **({"blobs": blobs} if blobs else {}),
        }

    def prune(self, before_tb: float) -> None:
        """Drop the records that ended before ``before_tb`` (the live hub's sliding window)."""
        with self.db:
            self.db.execute("DELETE FROM records WHERE tb + tEnd - t < ?", (before_tb,))

    def _blob_index(self, key: str) -> Record:
        rows = self.db.execute("SELECT ref, mime, size, sha256 FROM blobs WHERE key = ?", (key,))
        return {
            row["ref"]: {"mime": row["mime"], "size": row["size"], "sha256": row["sha256"]}
            for row in rows
        }


# -- display helpers -------------------------------------------------------------------------


def block_points(record: Record) -> list[Record]:
    """Expand a block record into ``{t, tb, v}`` points."""
    t0, dt = float(record["t0"]), float(record["dt"])
    tb0 = float(record["tb"]) + t0 - float(record["t"])
    return [
        {"t": round(t0 + i * dt, 3), "tb": round(tb0 + i * dt, 3), "v": value}
        for i, value in enumerate(record["samples"])
    ]


def points(records: list[Record], stream_type: str) -> list[Record]:
    if stream_type == "block":
        return [point for record in records for point in block_points(record)]
    return records


def downsample(rows: list[Record], lo: float, hi: float, max_points: int) -> list[Record]:
    """Min/max per bucket over ``tb``: at most ``max_points`` rows, extremes kept."""
    if len(rows) <= max_points:
        return rows
    buckets = max(1, max_points // 2)
    width = (hi - lo) / buckets or 1.0
    return _extremes(rows, lambda tb: max(0, min(buckets - 1, int((tb - lo) / width))))


def columns(rows: list[Record], col_ms: float) -> list[Record]:
    """Min/max per display column of the absolute grid ``floor(tb / col_ms)``: two points
    per column at most, so consecutive windows on the same grid line up."""
    if col_ms <= 0:
        return rows
    return _extremes(rows, lambda tb: math.floor(tb / col_ms))


def _extremes(rows: list[Record], bucket: Callable[[float], int]) -> list[Record]:
    chosen: dict[int, tuple[Record, Record]] = {}
    for row in rows:
        index = bucket(row["tb"])
        current = chosen.get(index)
        if current is None:
            chosen[index] = (row, row)
        else:
            low, high = current
            chosen[index] = (
                row if row["v"] < low["v"] else low,
                row if row["v"] > high["v"] else high,
            )
    result: list[Record] = []
    for index in sorted(chosen):
        low, high = chosen[index]
        pair = sorted({id(low): low, id(high): high}.values(), key=lambda item: item["tb"])
        result.extend(pair)
    return result


def bit_changes(rows: list[Record], max_points: int) -> list[Record]:
    """Keep the first row, every mask change and the last row; thin evenly if still too many."""
    kept: list[Record] = []
    for row in rows:
        if not kept or row.get("mask") != kept[-1].get("mask"):
            kept.append(row)
    if rows and kept[-1] is not rows[-1]:
        kept.append(rows[-1])
    if len(kept) > max_points:
        step = len(kept) / max_points
        kept = [kept[int(i * step)] for i in range(max_points - 1)] + [kept[-1]]
    return kept


def _row(row: sqlite3.Row) -> Record:
    record: Record = {"i": row["i"], "seq": row["seq"], "t": row["t"], "tb": row["tb"]}
    if row["op"] is not None:
        record["op"] = row["op"]
    record.update(json.loads(row["data"]))
    return record


def _slim(record: Record) -> Record:
    return {key: value for key, value in record.items() if key != "i"}


def _judge_record(record: Record) -> Record:
    return {key: value for key, value in record.items() if key not in {"i", "tb"}}


def _json(raw: str | None) -> Any:
    return None if raw is None else json.loads(raw)
