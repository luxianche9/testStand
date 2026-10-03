"""A finished run's protocol data for display (design §6.4, U4): message table and field curves.

Recordings keep only raw data; the run monitor re-decodes each bound source stream with the
ICD frozen in the recording (never the project's current file), exactly as re-judging does.
Decoding a long serial log is not free, so the decoded records of each source are cached by
the source stream's version: a live recording re-decodes when new raw data arrives.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any

from teststand_backend.protocol import decode_records
from teststand_backend.streams.data import stream_key
from teststand_backend.streams.store import StreamStore, columns

from .protocols import BoundProtocol, DerivedRef, PlanProtocols

Record = dict[str, Any]
MESSAGE_LIMIT = 2_000
MESSAGE_LIMIT_MAX = 10_000
CACHE_SIZE = 8


class DerivedViews:
    def __init__(self) -> None:
        self._cache: OrderedDict[tuple[Any, ...], dict[str, list[Record]]] = OrderedDict()

    @staticmethod
    def protocols(store: StreamStore) -> PlanProtocols:
        return PlanProtocols.from_snapshot(store.meta().get("protocols"))

    def decoded(self, run_id: str, store: StreamStore, binding: BoundProtocol) -> dict[str, Any]:
        """Every derived record of ``binding``, by derived stream id (empty when its source
        stream was never recorded)."""
        version = store.version(binding.source_key)
        if version is None:
            return {}
        cache_key = (run_id, binding.source_key, binding.alias, binding.icd_hash, version)
        hit = self._cache.get(cache_key)
        if hit is None:
            hit = decode_records(
                binding.icd,
                binding.alias,
                store.records(binding.source_key),
                gaps=store.gaps(binding.source_key),
                flush=True,
            )
            self._cache[cache_key] = hit
            while len(self._cache) > CACHE_SIZE:
                self._cache.popitem(last=False)
        else:
            self._cache.move_to_end(cache_key)
        return hit

    def messages(self, run_id: str, store: StreamStore, query: Record) -> Record:
        """Rows for the run monitor's message table: every decoded frame, undecodable frame
        and unframed byte run of every binding, in backend-time order."""
        protocols = self.protocols(store)
        limit = max(1, min(int(query.get("limit") or MESSAGE_LIMIT), MESSAGE_LIMIT_MAX))
        lo, hi = _number(query.get("t0")), _number(query.get("t1"))
        bindings: list[Record] = []
        rows: list[Record] = []
        for binding in protocols.bindings:
            recorded = store.version(binding.source_key) is not None
            bindings.append(
                {
                    "alias": binding.alias,
                    "icd": binding.icd.name,
                    "icdHash": binding.icd_hash,
                    "hardwareId": binding.hardware_id,
                    "streamId": binding.stream_id,
                    "source": binding.source_key,
                    "recorded": recorded,
                    "messages": [message.name for message in binding.icd.messages],
                }
            )
            decoded = self.decoded(run_id, store, binding) if recorded else {}
            for stream_id, stream in binding.streams.items():
                if stream.stream_type == "scalar":
                    continue
                kind = (
                    "unframed"
                    if stream.stream_type == "bytes"
                    else "message"
                    if stream.message
                    else "error"
                )
                for record in decoded.get(stream_id, []):
                    tb = _number(record.get("tb"))
                    if (lo is not None and (tb is None or tb < lo)) or (
                        hi is not None and (tb is None or tb > hi)
                    ):
                        continue
                    row: Record = {"alias": binding.alias, "streamId": stream_id, "kind": kind}
                    row.update(record)
                    if kind == "unframed":
                        row["raw"] = row.pop("data", "")
                    rows.append(row)
        rows.sort(key=lambda row: (_number(row.get("tb")) or 0.0, row.get("seq") or 0))
        return {
            "bindings": bindings,
            "messages": rows[:limit],
            "total": len(rows),
            "truncated": len(rows) > limit,
        }

    def stream_infos(
        self, run_id: str, store: StreamStore, recorded: dict[str, Record]
    ) -> list[Record]:
        """Stream-index entries for the derived numeric fields, so the scope can plot them;
        ``derived`` says where they come from. ``recorded`` is the recording's index by key."""
        output: list[Record] = []
        for binding in self.protocols(store).bindings:
            source = recorded.get(binding.source_key)
            if source is None:
                continue
            decoded = self.decoded(run_id, store, binding)
            for stream_id, stream in binding.streams.items():
                if stream.stream_type != "scalar":
                    continue
                rows = decoded.get(stream_id, [])
                output.append(
                    {
                        **source,
                        "key": stream_key(binding.hardware_id, stream_id),
                        "streamId": stream_id,
                        "type": "scalar",
                        "count": len(rows),
                        "first": _instant(rows[0]) if rows else None,
                        "last": _instant(rows[-1]) if rows else None,
                        "lastI": None,
                        "states": [],
                        "derived": {
                            "alias": binding.alias,
                            "icd": binding.icd.name,
                            "icdHash": binding.icd_hash,
                            "source": binding.source_key,
                            "message": stream.message,
                            "field": stream.field,
                            **({"unit": stream.unit} if stream.unit else {}),
                            **({"label": stream.label} if stream.label else {}),
                        },
                    }
                )
        return output

    def points(self, run_id: str, store: StreamStore, ref: DerivedRef) -> list[Record]:
        """``{t, tb, v}`` points of one derived numeric field, oldest first."""
        rows = self.decoded(run_id, store, ref.binding).get(ref.stream.stream_id, [])
        return [
            {"t": row["t"], "tb": row["tb"], "v": row["v"], "seq": row.get("seq")}
            for row in rows
            if _number(row.get("tb")) is not None
        ]

    def window(
        self,
        run_id: str,
        store: StreamStore,
        key: str,
        ref: DerivedRef,
        t0: float,
        t1: float,
        col_ms: float,
    ) -> Record:
        """A :meth:`StreamStore.window` of a derived numeric field: min/max per column, the
        value in force at ``t0`` first; gaps, watermark and state are the source stream's."""
        base = store.head(ref.binding.source_key, t0, t1, col_ms=col_ms)
        rows = self.points(run_id, store, ref)
        inside = [row for row in rows if t0 <= row["tb"] <= t1]
        before = [row for row in rows if row["tb"] < t0][-1:]
        prior = before if not inside or inside[0]["tb"] > t0 else []
        return {**base, "key": key, "type": "scalar", "points": prior + columns(inside, col_ms)}


def _instant(row: Record) -> Record:
    return {"t": row.get("t"), "tb": row.get("tb")}


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)
