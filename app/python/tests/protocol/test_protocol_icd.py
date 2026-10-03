from __future__ import annotations

from typing import Any

import pytest

from teststand_backend.contracts.errors import AppError
from teststand_backend.protocol import (
    Icd,
    ProtocolBinding,
    icd_document,
    icd_hash,
    icd_json_schema,
    load_icd,
    parse_icd,
)
from teststand_backend.protocol.icd import (
    HeaderLengthFraming,
    format_hex,
    parse_hex,
)
from teststand_backend.protocol.loader import icd_name_from_path

from .icd_fixtures import DUT_CMD_YAML, dut_cmd


def base(**overrides: Any) -> dict[str, Any]:
    document: dict[str, Any] = {
        "formatVersion": 1,
        "name": "t",
        "transport": "bytes",
        "framing": {"kind": "delimiter", "delimiter": "0A"},
        "messages": [{"name": "m", "match": {"length": 3}, "fields": []}],
    }
    document.update(overrides)
    return document


def invalid(document: dict[str, Any]) -> str:
    with pytest.raises(AppError) as caught:
        parse_icd(document)
    assert caught.value.category == "validation_failed"
    assert caught.value.details["issues"]
    return str(caught.value)


def test_loads_design_example() -> None:
    icd = dut_cmd()
    assert icd.name == "dut_cmd" and icd.transport == "bytes"
    assert isinstance(icd.framing, HeaderLengthFraming)
    assert icd.framing.header == b"\xaa\x55"
    assert icd.framing.length_field.offset == 2 and icd.framing.length_covers == "payload"
    assert icd.checksum is not None and icd.checksum.algorithm == "crc16_modbus"
    assert icd.checksum.range is not None and icd.checksum.range.from_ == 2
    assert icd.trailer_size() == 2
    status = icd.message("status")
    assert status.match[0].offset == 3 and status.match[0].value == 0x81
    self_test = status.fields[0]
    assert self_test.enum == {0: "fail", 1: "pass"} and self_test.bit_range == (0, 0)
    assert len(icd.message("mode_echo").match) == 2
    assert icd.encoder("set_mode").template.cmd == 0x10
    with pytest.raises(KeyError):
        icd.message("nope")
    with pytest.raises(KeyError):
        icd.encoder("nope")


def test_hash_ignores_formatting_and_is_canonical() -> None:
    icd = dut_cmd()
    reformatted = load_icd("# comment\n" + DUT_CMD_YAML.replace('"AA 55"', '"aa55"'))
    assert icd_hash(reformatted) == icd_hash(icd)
    assert icd_hash(icd).startswith("sha256:")
    document = icd_document(icd)
    assert document["framing"]["header"] == "AA 55"
    assert document["checksum"]["range"] == {"from": 2, "to": -2}
    assert parse_icd(document) == icd
    changed = document | {"description": "other"}
    assert icd_hash(parse_icd(changed)) != icd_hash(icd)


def test_json_schema_exports_camel_case() -> None:
    schema = icd_json_schema()
    assert "formatVersion" in schema["properties"]
    text = str(schema)
    assert "lengthCovers" in text and "header_length" in text and "idMask" in text


def test_hex_parsing() -> None:
    assert parse_hex("AA 55") == parse_hex("aa55") == parse_hex("0xAA 0x55") == b"\xaa\x55"
    assert parse_hex("aa,55") == parse_hex([0xAA, 0x55]) == parse_hex(b"\xaa\x55")
    assert format_hex(b"\xaa\x05") == "AA 05"
    assert parse_hex(" ") == parse_hex(format_hex(b"")) == b""
    for bad in ("A", "zz", 12, [256], "0xAAA", "AA,,5"):
        with pytest.raises(ValueError):
            parse_hex(bad)


@pytest.mark.parametrize(
    ("overrides", "needle"),
    [
        ({"framing": None}, "needs framing"),
        ({"transport": "frames"}, "remove framing"),
        ({"messages": []}, "at least one message"),
        ({"checksum": {"algorithm": "crc_magic"}}, "unknown checksum algorithm"),
        ({"formatVersion": 2}, "formatVersion"),
        ({"extra": 1}, "extra"),
        ({"framing": {"kind": "delimiter", "delimiter": ""}}, "non-empty delimiter"),
        ({"framing": {"kind": "fixed", "length": 1, "header": "AA 55"}}, "longer than"),
        (
            {"framing": {"kind": "header_length", "header": "", "lengthField": {"offset": 0}}},
            "non-empty header",
        ),
        (
            {
                "framing": {
                    "kind": "header_length",
                    "header": "AA",
                    "lengthField": {"offset": 1},
                    "trailer": "checksum",
                }
            },
            "needs a checksum section",
        ),
        (
            {
                "framing": {"kind": "header_length", "header": "AA", "lengthField": {"offset": 1}},
                "checksum": {"algorithm": "sum8"},
            },
            "trailer: checksum",
        ),
        (
            {
                "messages": [
                    {"name": "m", "match": {"length": 1}},
                    {"name": "m", "match": {"length": 2}},
                ]
            },
            "duplicate message",
        ),
        ({"messages": [{"name": "m", "match": {"id": 1}}]}, "transport frames"),
        ({"messages": [{"name": "m", "match": {"offset": 1}}]}, "both offset and value"),
        ({"messages": [{"name": "m", "match": {"size": 2}}]}, "offset+value, id or length"),
        ({"messages": [{"name": "m", "match": {"length": 1, "idMask": 3}}]}, "idMask needs id"),
        ({"messages": [{"name": "m", "match": {"offset": 0, "value": 256}}]}, "does not fit"),
        ({"messages": [{"name": "m", "match": []}]}, "at least 1"),
        ({"messages": [{"name": "1m", "match": {"length": 1}}]}, "pattern"),
    ],
)
def test_document_validation(overrides: dict[str, Any], needle: str) -> None:
    document = base(**overrides)
    if document.get("framing") is None:
        document.pop("framing")
    assert needle in invalid(document)


@pytest.mark.parametrize(
    ("field", "needle"),
    [
        ({"name": "a", "type": "u8"}, "needs offset and type"),
        ({"name": "a", "offset": 0, "type": "ascii"}, "need length"),
        ({"name": "a", "offset": 0, "type": "bytes", "length": 2, "scale": 2}, "no transforms"),
        ({"name": "a", "offset": 0, "type": "u8", "length": 2}, "only applies to ascii"),
        ({"name": "a", "offset": 0, "type": "f32", "bits": "1"}, "integer types"),
        ({"name": "a", "offset": 0, "type": "u8", "bits": "3..8"}, "exceed u8"),
        ({"name": "a", "offset": 0, "type": "u8", "bits": "5..3"}, "lo..hi"),
        ({"name": "a", "offset": 0, "type": "u8", "bits": "x"}, "lo..hi"),
        ({"name": "a", "offset": 0, "type": "f64", "enum": {0: "x"}}, "enum only"),
        ({"name": "a", "offset": 0, "type": "u8", "scale": 0}, "scale must not be 0"),
        ({"name": "a", "offset": 0, "type": "u8", "expr": "1"}, "no offset"),
        ({"name": "a", "expr": "1", "enum": {0: "x"}}, "cannot have enum"),
        ({"name": "a", "expr": "later + 1"}, "unknown field"),
        ({"name": "a", "expr": "foo.bar"}, "Attribute is not allowed"),
        ({"name": "a", "expr": "2 ** 8"}, "Pow is not allowed"),
        ({"name": "a", "expr": "open(1)"}, "only the functions"),
        ({"name": "a", "expr": "abs(x=1)"}, "keyword"),
        ({"name": "a", "expr": "None"}, "literal"),
        ({"name": "a", "expr": "1 +"}, "invalid expression"),
        ({"name": "a", "expr": " "}, "1..512"),
    ],
)
def test_field_validation(field: dict[str, Any], needle: str) -> None:
    message = {"name": "m", "match": {"length": 1}, "fields": [field]}
    assert needle in invalid(base(messages=[message]))


def test_field_names_unique_and_expr_sees_earlier_fields_only() -> None:
    fields = [{"name": "a", "offset": 0, "type": "u8"}, {"name": "a", "offset": 1, "type": "u8"}]
    message = {"name": "m", "match": {"length": 1}, "fields": fields}
    assert "duplicate field" in invalid(base(messages=[message]))
    ok = [{"name": "a", "offset": 0, "type": "u8"}, {"name": "b", "expr": "a && !false"}]
    parse_icd(base(messages=[{"name": "m", "match": {"length": 1}, "fields": ok}]))


def test_encoder_validation() -> None:
    encoders = [{"name": "e", "fields": [{"name": "a", "expr": "1"}]}]
    assert "decode-only" in invalid(base(encoders=encoders))
    encoders = [{"name": "e", "fields": [{"name": "a", "offset": -1, "type": "u8"}]}]
    assert "offset must be >= 0" in invalid(base(encoders=encoders))
    encoders = [{"name": "e"}, {"name": "e"}]
    assert "duplicate encoder" in invalid(base(encoders=encoders))
    only_encoder = base(messages=[], encoders=[{"name": "e"}])
    assert parse_icd(only_encoder).encoders[0].template.fill == 0


def test_yaml_loading_errors() -> None:
    def category(text: str) -> str:
        with pytest.raises(AppError) as caught:
            load_icd(text)
        return caught.value.category

    assert category("!!python/object:os.system {}") == "invalid_argument"
    assert category("a: 1\na: 2\n") == "invalid_argument"
    assert category("a: [1\n") == "invalid_argument"
    assert category("- 1\n") == "validation_failed"
    assert category("formatVersion: 1\n") == "validation_failed"


def test_protocol_binding_and_file_names() -> None:
    binding = ProtocolBinding.model_validate(
        {
            "icd": "dut_cmd",
            "source": {"hardwareId": "PC1.CP118U", "streamId": "serial1"},
            "alias": "dut",
        }
    )
    assert binding.source.stream_id == "serial1"
    assert binding.model_dump(by_alias=True)["source"]["hardwareId"] == "PC1.CP118U"
    assert icd_name_from_path("dut_cmd.icd.yaml") == "dut_cmd"
    assert icd_name_from_path("plan.yaml") is None


def test_models_are_frozen() -> None:
    icd = dut_cmd()
    assert isinstance(icd, Icd)
    with pytest.raises(ValueError):
        icd.name = "other"
