"""DUT protocol layer: ICD-driven decoding of raw bytes/frames streams (design ch. 6).

Domain layer (§9.2): pure logic over records and bytes, no I/O. Depends only on the standard
library, Pydantic and :mod:`hardwareharness_backend.contracts` (plus ``ruamel.yaml`` in
:mod:`.loader` for parsing ICD text).

* :mod:`.icd`       — ICD schema (Pydantic models), JSON Schema export, canonical hash
* :mod:`.checksums` — named checksum/CRC table with RevEng check values (§6.3)
* :mod:`.framing`   — incremental framers: header_length, delimiter, fixed, SLIP, COBS
* :mod:`.codec`     — checksum verification, message matching, field decoding, frame building
* :mod:`.derived`   — derived field streams from raw records (§6.4)
* :mod:`.loader`    — ``load_icd(yaml_text)``
"""

from __future__ import annotations

from .checksums import ALGORITHM_NAMES, ALGORITHMS, CHECK_INPUT, ChecksumAlgorithm, compute
from .codec import (
    ChecksumResult,
    DecodedFrame,
    EncodedFrame,
    decode_frame,
    encode,
    find_message,
    verify_checksum,
)
from .derived import (
    ERRORS,
    UNFRAMED,
    DerivedRecord,
    DerivedStream,
    ProtocolDecoder,
    decode_records,
    derived_streams,
)
from .framing import FramerEvent, make_framer
from .icd import (
    Icd,
    IcdField,
    Message,
    ProtocolBinding,
    icd_document,
    icd_hash,
    icd_json_schema,
)
from .loader import load_icd, parse_icd

__all__ = [
    "ALGORITHMS",
    "ALGORITHM_NAMES",
    "CHECK_INPUT",
    "ERRORS",
    "UNFRAMED",
    "ChecksumAlgorithm",
    "ChecksumResult",
    "DecodedFrame",
    "DerivedRecord",
    "DerivedStream",
    "EncodedFrame",
    "FramerEvent",
    "Icd",
    "IcdField",
    "Message",
    "ProtocolBinding",
    "ProtocolDecoder",
    "compute",
    "decode_frame",
    "decode_records",
    "derived_streams",
    "encode",
    "find_message",
    "icd_document",
    "icd_hash",
    "icd_json_schema",
    "load_icd",
    "make_framer",
    "parse_icd",
    "verify_checksum",
]
