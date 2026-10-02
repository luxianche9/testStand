"""A plan's protocol bindings (design §6.4/§6.5): derived streams, decoding and encoding.

``protocolBindings: [{icd, source: {hardwareId, streamId}, alias}]`` puts an ICD on a raw
``bytes``/``frames`` stream; steps then name derived streams on the source hardware, e.g.
``{hardwareId: dut, streamId: dut.status.voltage}``. The compiler freezes every ICD the plan
uses (bindings and ``InvokeTool.encode``) into the compiled plan as ``icds: {name: {icdHash,
document}}``; the run stores that snapshot in its recording so re-judging decodes the recorded
raw data with exactly the ICD the run used.

Pure: no I/O. The caller hands in raw records read from the recording.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from hardwareharness_backend.protocol import (
    DerivedStream,
    Icd,
    ProtocolBinding,
    ProtocolDecoder,
    decode_records,
    derived_streams,
    encode,
    icd_document,
    icd_hash,
    parse_icd,
)
from hardwareharness_backend.protocol.derived import ALIAS
from hardwareharness_backend.streams.data import StreamData, stream_key

from .models import iter_steps

Record = dict[str, Any]
IcdLookup = Callable[[str], Icd | None]
CONTEXT_RECORDS = 16  # records before the window, as :meth:`StreamStore.stream_data` gives
ENCODE_ARGUMENTS = ("data", "hex", "hex_data", "payload", "frame")
"""Tool arguments ``InvokeTool.encode`` fills when the step names none (first one declared)."""


@dataclass(frozen=True)
class BoundProtocol:
    alias: str
    icd: Icd
    icd_hash: str
    hardware_id: str
    stream_id: str
    streams: dict[str, DerivedStream]

    @property
    def source_key(self) -> str:
        return stream_key(self.hardware_id, self.stream_id)


@dataclass(frozen=True)
class DerivedRef:
    """One derived stream a step names, with the binding that produces it."""

    binding: BoundProtocol
    stream: DerivedStream

    @property
    def descriptor(self) -> Record:
        """Stream descriptor for the judge: protocol fields are evidence grade ``P`` (§7.7)."""
        info: Record = {
            "kind": "protocol",
            "evidenceType": "P",
            "icd": self.binding.icd.name,
            "icdHash": self.binding.icd_hash,
            "source": self.binding.source_key,
        }
        if self.stream.unit:
            info["unit"] = self.stream.unit
        return info


class PlanProtocols:
    """The protocol bindings of one compiled plan (or of one recording)."""

    def __init__(self, icds: Mapping[str, Icd], bindings: list[ProtocolBinding]) -> None:
        self.icds = dict(icds)
        self.bindings: list[BoundProtocol] = []
        for binding in bindings:
            icd = self.icds.get(binding.icd)
            if icd is None:
                continue
            self.bindings.append(
                BoundProtocol(
                    binding.alias,
                    icd,
                    icd_hash(icd),
                    binding.source.hardware_id,
                    binding.source.stream_id,
                    {item.stream_id: item for item in derived_streams(icd, binding.alias)},
                )
            )

    @classmethod
    def from_snapshot(cls, snapshot: Any) -> PlanProtocols:
        """From ``{icds: {name: {document}}, bindings: [...]}`` (compiled plan or recording)."""
        data = snapshot if isinstance(snapshot, dict) else {}
        icds: dict[str, Icd] = {}
        for name, entry in (data.get("icds") or {}).items():
            if isinstance(entry, dict) and isinstance(entry.get("document"), dict):
                icds[str(name)] = parse_icd(entry["document"])
        return cls(icds, _bindings(data.get("bindings")))

    @classmethod
    def from_plan(cls, plan: Record) -> PlanProtocols:
        return cls.from_snapshot(
            {"icds": plan.get("icds"), "bindings": plan.get("protocolBindings")}
        )

    def snapshot(self) -> Record:
        return {
            "icds": {
                name: {"icdHash": icd_hash(icd), "document": icd_document(icd)}
                for name, icd in sorted(self.icds.items())
            },
            "bindings": [
                {
                    "icd": item.icd.name,
                    "alias": item.alias,
                    "source": {"hardwareId": item.hardware_id, "streamId": item.stream_id},
                    "icdHash": item.icd_hash,
                }
                for item in self.bindings
            ],
        }

    def __bool__(self) -> bool:
        return bool(self.icds)

    def derived(self, hardware_id: str, stream_id: str) -> DerivedRef | None:
        for binding in self.bindings:
            stream = binding.streams.get(stream_id)
            if binding.hardware_id == hardware_id and stream is not None:
                return DerivedRef(binding, stream)
        return None

    def derived_by_key(self, key: str) -> DerivedRef | None:
        hardware_id, _, stream_id = key.partition("__")
        return self.derived(hardware_id, stream_id)

    def streams(self, hardware_id: str) -> dict[str, str]:
        """``{derivedStreamId: type}`` of every binding on the hardware."""
        return {
            stream_id: stream.stream_type
            for binding in self.bindings
            if binding.hardware_id == hardware_id
            for stream_id, stream in binding.streams.items()
        }

    def hardware_ids(self) -> list[str]:
        return sorted({binding.hardware_id for binding in self.bindings})

    def encode_arguments(self, spec: Record, arguments: Record, target: str) -> Record:
        """Arguments with the ICD-built frame in ``target`` (and ``id`` for frames ICDs)."""
        icd = self.icds.get(str(spec.get("icd")))
        if icd is None:
            raise ValueError(f"ICD {spec.get('icd')!r} is not part of the compiled plan")
        fields = spec.get("fields") or {}
        frame = encode(icd, str(spec.get("message")), fields if isinstance(fields, dict) else {})
        output = {**arguments, target: frame.wire.hex()}
        if frame.id is not None and "id" not in arguments:
            output["id"] = frame.id
        return output


def derived_data(
    ref: DerivedRef,
    raw: list[Record],
    source: StreamData,
    t0: float,
    t1: float,
) -> StreamData:
    """Judge input for derived stream ``ref`` over ``[t0, t1]``, decoded from the raw records.

    ``raw`` holds the source stream's recorded records from the start of the recording (the
    framer needs the byte history); ``source`` supplies its gaps, watermark and clock, which
    the derived stream inherits unchanged (§6.4).
    """
    records = decode(ref, raw, source.gaps)
    before = [record for record in records if float(record["t"]) < t0][-CONTEXT_RECORDS:]
    inside = [record for record in records if t0 <= float(record["t"]) <= t1]
    return StreamData(
        ref.stream.stream_type,
        [_judge_record(record) for record in before + inside],
        gaps=source.gaps,
        watermark=source.watermark,
        clock=source.clock,
        descriptor=ref.descriptor,
    )


def decode(ref: DerivedRef, raw: list[Record], gaps: list[Record]) -> list[Record]:
    """Every record of the derived stream, oldest first (deterministic in ``raw`` and the ICD)."""
    decoded = decode_records(ref.binding.icd, ref.binding.alias, raw, gaps=gaps)
    return decoded.get(ref.stream.stream_id, [])


def live_decoder(ref: DerivedRef) -> Callable[[list[Record] | None], list[Record]]:
    """Incremental decoding for a live ``Guard``: feed raw records (``None`` for a gap) and
    get the new records of the derived stream ``ref``."""
    decoder = ProtocolDecoder(ref.binding.icd, ref.binding.alias)
    stream_id = ref.stream.stream_id

    def feed(records: list[Record] | None) -> list[Record]:
        derived = decoder.gap() if records is None else []
        for record in records or []:
            derived += decoder.feed(record)
        return [_judge_record(item.record) for item in derived if item.stream_id == stream_id]

    return feed


# -- validation ----------------------------------------------------------------------------


def resolve(
    plan: Record, lookup: IcdLookup | None, declared: Callable[[str], Any]
) -> tuple[PlanProtocols, list[Record]]:
    """Resolve the plan's bindings and ``encode`` ICDs; issues for everything unresolved."""
    issues: list[Record] = []
    raw = plan.get("protocolBindings", [])
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        return PlanProtocols({}, []), [
            issue(
                "error",
                "protocol.bindings",
                "protocolBindings must be an array",
                "/protocolBindings",
            )
        ]
    icds: dict[str, Icd] = {}

    def find(name: str, where: str) -> Icd | None:
        if name in icds:
            return icds[name]
        icd = lookup(name) if lookup is not None else None
        if icd is None:
            message = (
                f"ICD {name} was not found in the project's icd/ directory"
                if lookup is not None
                else f"ICD {name} cannot be resolved without a project"
            )
            issues.append(issue("error", "protocol.icd_missing", message, where))
            return None
        icds[name] = icd
        return icd

    bindings: list[ProtocolBinding] = []
    aliases: set[str] = set()
    for index, item in enumerate(raw):
        where = f"/protocolBindings/{index}"
        try:
            binding = ProtocolBinding.model_validate(item)
        except ValidationError as error:
            detail = "; ".join(
                f"{'.'.join(str(part) for part in entry['loc']) or '<root>'}: {entry['msg']}"
                for entry in error.errors(include_url=False, include_input=False)
            )
            issues.append(issue("error", "protocol.binding", f"Invalid binding: {detail}", where))
            continue
        if binding.alias in aliases:
            issues.append(
                issue(
                    "error", "protocol.alias", f"Duplicate alias {binding.alias}", where + "/alias"
                )
            )
            continue
        aliases.add(binding.alias)
        icd = find(binding.icd, where + "/icd")
        streams = declared(binding.source.hardware_id)
        source_type = (streams or {}).get(binding.source.stream_id) if streams is not None else None
        if streams is not None and source_type is None:
            issues.append(
                issue(
                    "error",
                    "protocol.source",
                    f"{binding.source.hardware_id} has no stream {binding.source.stream_id}",
                    where + "/source/streamId",
                )
            )
        elif icd is not None and source_type is not None and source_type != icd.transport:
            issues.append(
                issue(
                    "error",
                    "protocol.source",
                    f"ICD {icd.name} decodes {icd.transport} streams; "
                    f"{binding.source.stream_id} is {source_type}",
                    where + "/source/streamId",
                )
            )
        bindings.append(binding)
    for path, step in _encode_steps(plan):
        spec = step["encode"]
        if not isinstance(spec, dict) or not isinstance(spec.get("icd"), str):
            issues.append(
                issue(
                    "error", "invoke.encode", "encode is {icd, message, fields}", path + "/encode"
                )
            )
            continue
        icd = find(spec["icd"], path + "/encode/icd")
        if icd is not None:
            issues.extend(_encode_issues(icd, spec, path + "/encode"))
    return PlanProtocols(icds, bindings), issues


def encode_target(spec: Record, input_schema: Any) -> str | None:
    """The tool argument the encoded frame goes into: ``encode.argument`` or a known name."""
    properties = input_schema.get("properties") if isinstance(input_schema, dict) else None
    names = list(properties) if isinstance(properties, dict) else []
    if isinstance(spec.get("argument"), str):
        return str(spec["argument"]) if spec["argument"] in names else None
    return next((name for name in ENCODE_ARGUMENTS if name in names), None)


def _encode_issues(icd: Icd, spec: Record, where: str) -> list[Record]:
    try:
        encoder = icd.encoder(str(spec.get("message")))
    except KeyError:
        names = ", ".join(item.name for item in icd.encoders) or "none"
        return [
            issue(
                "error",
                "invoke.encode",
                f"ICD {icd.name} has no encoder {spec.get('message')!r}; encoders: {names}",
                where + "/message",
            )
        ]
    fields = spec.get("fields", {})
    if not isinstance(fields, dict):
        return [
            issue("error", "invoke.encode", "encode.fields must be an object", where + "/fields")
        ]
    known = {item.name for item in encoder.fields}
    unknown = sorted(set(fields) - known)
    if unknown:
        return [
            issue(
                "error",
                "invoke.encode",
                f"encoder {encoder.name} has no field(s) {', '.join(unknown)}",
                where + "/fields",
            )
        ]
    if any(_bound_later(value) for value in fields.values()):
        return []
    try:
        encode(icd, encoder.name, fields)
    except Exception as error:  # an out-of-range literal, a bad enum name ...
        return [issue("error", "invoke.encode", str(error), where + "/fields")]
    return []


def _encode_steps(plan: Record) -> list[tuple[str, Record]]:
    return [
        (path, step)
        for path, step in iter_steps(plan)
        if step.get("type") == "InvokeTool" and step.get("encode") is not None
    ]


def issue(severity: str, code: str, message: str, path: str = "") -> Record:
    return {"severity": severity, "code": code, "message": message, "path": path}


def _bindings(raw: Any) -> list[ProtocolBinding]:
    output: list[ProtocolBinding] = []
    for item in raw if isinstance(raw, list) else []:
        try:
            # A snapshot binding also records its ``icdHash`` (not part of the plan schema).
            plain = (
                {k: v for k, v in item.items() if k != "icdHash"}
                if isinstance(item, dict)
                else item
            )
            output.append(ProtocolBinding.model_validate(plain))
        except ValidationError:
            continue
    return output


def _bound_later(value: Any) -> bool:
    return isinstance(value, dict) and set(value) == {"expression"}


def _judge_record(record: Record) -> Record:
    return {key: value for key, value in record.items() if key not in {"i", "tb"}}


# -- ICD authoring: describe, check and trial-decode (U5) ----------------------------------


def describe_icd(icd: Icd, alias: str | None = None) -> Record:
    """What an ICD provides: its messages, encoders and derived streams under ``alias``."""
    streams: list[Record] = []
    for item in derived_streams(icd, _alias(icd, alias)):
        entry: Record = {"streamId": item.stream_id, "type": item.stream_type}
        if item.unit:
            entry["unit"] = item.unit
        if item.label:
            entry["label"] = item.label
        streams.append(entry)
    return {
        "name": icd.name,
        "icdHash": icd_hash(icd),
        "transport": icd.transport,
        "description": icd.description,
        "messages": [message.name for message in icd.messages],
        "encoders": [encoder.name for encoder in icd.encoders],
        "streams": streams,
    }


def trial_decode(icd: Icd, samples: list[Any], alias: str | None = None) -> Record:
    """Decode sample raw records (or hex strings) as one live stream would, then flush.

    Returns ``{streamId: records}`` of every derived stream that produced something; samples
    without a ``t`` are spaced 1 ms apart.
    """
    records: list[Record] = []
    for index, sample in enumerate(samples):
        record = {"data": sample} if isinstance(sample, str) else dict(sample)
        record["data"] = "".join(str(record.get("data") or "").split())
        record.setdefault("t", index / 1000)
        record.setdefault("seq", index)
        records.append(record)
    decoded = decode_records(icd, _alias(icd, alias), records, flush=True)
    return {
        stream_id: [_judge_record(record) for record in items]
        for stream_id, items in decoded.items()
    }


def _alias(icd: Icd, alias: str | None) -> str:
    if alias:
        return alias
    return icd.name if ALIAS.match(icd.name) else "dut"
