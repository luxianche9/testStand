"""The private process codec must not change structured-clone facade values."""

from __future__ import annotations

import math
from datetime import UTC, datetime

import pytest

from hardwareharness_backend.compat import UNDEFINED
from hardwareharness_backend.host.codec import decode, encode


def test_nested_binary_missing_and_dates_round_trip() -> None:
    date = datetime(2026, 8, 15, tzinfo=UTC)
    data = {"data": bytes([0, 1, 127, 255]), "nested": [UNDEFINED, date, None]}
    restored = decode(encode(data))
    assert restored == data
    assert restored["nested"][0] is UNDEFINED


def test_tag_shaped_user_records_do_not_collide() -> None:
    data = {"type": "bytes", "$type": "undefined", "value": "AQI=", "__proto__": {}}
    assert decode(encode(data)) == data


def test_special_numbers_preserve_negative_zero_and_nan() -> None:
    values = decode(encode([-0.0, math.nan, math.inf, -math.inf]))
    assert math.copysign(1, values[0]) == -1
    assert math.isnan(values[1])
    assert values[2:] == [math.inf, -math.inf]


def test_four_megabytes_use_base64_not_number_arrays() -> None:
    raw = b"\xff" * (4 * 1024 * 1024)
    encoded = encode(raw)
    assert encoded[0] == "bytes"
    assert isinstance(encoded[1], str)
    assert len(encoded[1]) < len(raw) * 1.34
    assert decode(encoded) == raw


@pytest.mark.parametrize("value", [[], ["bad"], ["bytes", "!invalid"], ["object", [0]]])
def test_invalid_frames_fail_without_interpreting_user_code(value: object) -> None:
    with pytest.raises(ValueError):
        decode(value)
