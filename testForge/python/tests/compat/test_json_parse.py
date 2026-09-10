from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

from testforge_backend.compat import json_parse

# Recorded from Electron 36.9.5 / Node 22.19.0 / V8 13.6.233.17-electron.0.
CASES = json.loads(Path(__file__).with_name("json_parse_cases.json").read_text("utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[repr(case["input"]) for case in CASES])
def test_electron_json_parse_errors(case: dict[str, Any]) -> None:
    with pytest.raises(ValueError) as caught:
        json_parse(case["input"])
    assert str(caught.value) == case["error"]


def test_json_numbers_use_ieee_double_and_preserve_negative_zero() -> None:
    assert json_parse("9007199254740993") == 9007199254740992
    assert math.copysign(1, json_parse("-0")) == -1
    assert math.copysign(1, json_parse("-0.0")) == -1
    assert json_parse("1e400") == math.inf
    assert json_parse("-1e400") == -math.inf


def test_duplicate_names_last_wins_and_surrogate_strings_match() -> None:
    assert json_parse('{"a":1,"a":2,"__proto__":{"x":1}}') == {"a": 2, "__proto__": {"x": 1}}
    assert json_parse('"\\ud83d\\ude00"') == "\U0001f600"
    assert json_parse('"\\ud800"') == "\ud800"
    assert json_parse('[true,false,null,"\\/\\b\\f\\n\\r\\t"]') == [
        True,
        False,
        None,
        "/\b\f\n\r\t",
    ]
