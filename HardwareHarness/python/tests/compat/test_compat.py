import math

from hardwareharness_backend.compat import (
    UNDEFINED,
    clone,
    js_number,
    js_object_is,
    js_remainder,
    js_strict_equal,
    js_string,
    js_truthy,
    json_stringify,
    utf16_compare,
)


def test_json_javascript_bytes() -> None:
    assert (
        json_stringify(
            {
                "2": "two",
                "1": "one",
                "text": "中文😀",
                "one": 1.0,
                "zero": -0.0,
                "tiny": 1e-7,
                "boundary": 1e-6,
                "missing": UNDEFINED,
                "array": [UNDEFINED, math.nan, math.inf],
            }
        )
        == '{"1":"one","2":"two","text":"中文😀","one":1,"zero":0,"tiny":1e-7,'
        '"boundary":0.000001,"array":[null,null,null]}'
    )
    assert json_stringify({"ready": True}, 2) == '{\n  "ready": true\n}'
    assert json_stringify("\ud800") == '"\\ud800"'
    assert clone(UNDEFINED) is UNDEFINED


def test_expression_primitives() -> None:
    assert js_truthy([]) and js_truthy({})
    assert not js_truthy(UNDEFINED) and not js_truthy(float("nan"))
    assert js_number(None) == 0 and js_number([]) == 0
    assert js_number("0x10") == 16 and math.isnan(js_number({}))
    assert js_string([None, UNDEFINED, 1]) == ",,1"
    assert not js_strict_equal(True, 1) and not js_strict_equal({}, {})
    assert js_object_is(float("nan"), float("nan"))
    assert not js_object_is(-0.0, 0.0)
    assert js_remainder(-5, 2) == -1
    assert utf16_compare("😀", "\ue000") < 0
