from __future__ import annotations

from typing import Any

Record = dict[str, Any]


def step_catalog(plugin_steps: list[Any] | None = None) -> list[Record]:
    common = {"type": "object", "additionalProperties": True}
    items: list[Record] = [
        _item("Sequence", "流程", "顺序", common, container=True),
        _item("Group", "流程", "分组", common, container=True),
        _item(
            "If",
            "流程",
            "条件",
            {
                "type": "object",
                "properties": {"condition": _expression("条件表达式", "false", "condition")},
                "required": ["condition"],
            },
            container=True,
        ),
        _item(
            "Repeat",
            "流程",
            "重复",
            {
                "type": "object",
                "properties": {
                    "count": {"type": "integer", "title": "重复次数", "minimum": 0, "default": 1}
                },
                "required": ["count"],
            },
            container=True,
        ),
        _item(
            "ForEach",
            "流程",
            "遍历",
            {
                "type": "object",
                "properties": {"itemsExpression": _expression("集合表达式", "[]", "value")},
                "required": ["itemsExpression"],
            },
            container=True,
        ),
        _item("Parallel", "流程", "并行", common, container=True),
        _item(
            "Retry",
            "流程",
            "重试",
            {
                "type": "object",
                "properties": {
                    "attempts": {
                        "type": "integer",
                        "title": "最多尝试次数",
                        "minimum": 1,
                        "maximum": 20,
                        "default": 2,
                    },
                    "delayMs": {
                        "type": "integer",
                        "title": "尝试间隔",
                        "minimum": 0,
                        "default": 0,
                        "x-hh-unit": "ms",
                    },
                },
            },
            container=True,
        ),
        _item(
            "SetVariable",
            "数据",
            "设置变量",
            {
                "type": "object",
                "properties": {
                    "variable": {"type": "string", "title": "变量名", "default": "value"},
                    "valueExpression": _expression("值表达式", "null", "value"),
                },
                "required": ["variable"],
            },
        ),
        _item(
            "Evaluate",
            "数据",
            "计算表达式",
            {
                "type": "object",
                "properties": {"expression": _expression("计算表达式", "null", "value")},
                "required": ["expression"],
            },
        ),
        _item(
            "Delay",
            "数据",
            "延时",
            {
                "type": "object",
                "properties": {
                    "durationMs": {
                        "type": "integer",
                        "title": "等待时间",
                        "minimum": 0,
                        "default": 1000,
                        "x-hh-unit": "ms",
                    }
                },
                "required": ["durationMs"],
            },
        ),
        _item(
            "WaitUntil",
            "数据",
            "等待条件",
            {
                "type": "object",
                "properties": {
                    "condition": _expression("等待条件", "false", "condition"),
                    "timeoutMs": {
                        "type": "integer",
                        "title": "超时时间",
                        "minimum": 1,
                        "default": 30000,
                        "x-hh-unit": "ms",
                    },
                    "pollIntervalMs": {
                        "type": "integer",
                        "title": "检查间隔",
                        "minimum": 10,
                        "default": 100,
                        "x-hh-unit": "ms",
                    },
                },
                "required": ["condition"],
            },
        ),
        _item(
            "InvokeTool",
            "硬件",
            "调用设备工具",
            {
                "type": "object",
                "properties": {
                    "hardwareId": {"type": "string"},
                    "toolName": {"type": "string"},
                    "bindingRevision": {"type": "string"},
                    "arguments": {"type": "object"},
                    "timeoutMs": {
                        "type": "integer",
                        "title": "超时时间",
                        "minimum": 1,
                        "default": 30000,
                        "x-hh-unit": "ms",
                    },
                    "errorPolicy": {
                        "type": "string",
                        "title": "错误策略",
                        "enum": ["error", "fail"],
                        "default": "error",
                    },
                },
                "required": [
                    "hardwareId",
                    "toolName",
                    "bindingRevision",
                    "arguments",
                ],
                "additionalProperties": True,
            },
        ),
        _item(
            "Equal",
            "判定",
            "等于",
            _value_schema({"expected": {}, "expectedExpression": {"type": "string"}}),
        ),
        _item(
            "Range",
            "判定",
            "范围",
            _value_schema(
                {
                    "minimum": {},
                    "minimumExpression": {"type": "string"},
                    "maximum": {},
                    "maximumExpression": {"type": "string"},
                }
            ),
        ),
        _item(
            "Tolerance",
            "判定",
            "容差",
            _value_schema(
                {
                    "expected": {},
                    "expectedExpression": {"type": "string"},
                    "tolerance": {},
                    "toleranceExpression": {"type": "string"},
                }
            ),
        ),
        _item(
            "Bitmask",
            "判定",
            "位掩码",
            _value_schema(
                {
                    "expected": {},
                    "expectedExpression": {"type": "string"},
                    "mask": {},
                    "maskExpression": {"type": "string"},
                }
            ),
        ),
        _item(
            "PublishResult",
            "判定",
            "发布结果",
            {
                "type": "object",
                "properties": {
                    "value": {"title": "结果值"},
                    "valueExpression": _expression("结果值表达式", "", "value"),
                    "unit": {"type": "string", "title": "单位"},
                    "metadata": {"type": "object", "title": "附加信息"},
                    "verdict": {
                        "title": "判定",
                        "type": "string",
                        "enum": [
                            "NotSet",
                            "Pass",
                            "Inconclusive",
                            "Fail",
                            "Aborted",
                            "Error",
                        ],
                    },
                },
                "additionalProperties": True,
            },
        ),
    ]
    for plugin in plugin_steps or []:
        items.append(
            {
                "type": plugin.type_name,
                "category": "插件",
                "label": getattr(plugin, "label", plugin.type_name),
                "settingsSchema": plugin.settings_schema,
                "outputSchema": plugin.output_schema,
                "container": False,
            }
        )
    return items


def _item(
    type_name: str, category: str, label: str, settings: Record, container: bool = False
) -> Record:
    return {
        "type": type_name,
        "category": category,
        "label": label,
        "settingsSchema": settings,
        "outputSchema": {},
        "container": container,
    }


_VALUE_TITLES = {
    "actual": "实际值",
    "expected": "期望值",
    "minimum": "下限",
    "maximum": "上限",
    "tolerance": "容差",
    "mask": "掩码",
}


def _value_schema(extra: Record) -> Record:
    fields = {"actual": {}, "actualExpression": {"type": "string"}, **extra}
    normalized = {
        key: _expression(f"{_VALUE_TITLES[key.removesuffix('Expression')]}表达式", "", "value")
        if key.endswith("Expression")
        else {**value, "title": _VALUE_TITLES[key], "description": "固定值；填写表达式时以表达式为准"}
        for key, value in fields.items()
    }
    return {
        "type": "object",
        "properties": normalized,
        "additionalProperties": True,
    }


def _expression(title: str, default: str, mode: str) -> Record:
    return {
        "type": "string",
        "title": title,
        "default": default,
        "format": "hh-cel",
        "x-hh-expression-mode": mode,
    }
