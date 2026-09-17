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
                "properties": {"condition": {"type": "string"}},
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
                "properties": {"count": {"type": "integer", "minimum": 0}},
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
                "properties": {"itemsExpression": {"type": "string"}},
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
                    "attempts": {"type": "integer", "minimum": 1, "maximum": 20},
                    "delayMs": {"type": "integer", "minimum": 0},
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
                    "variable": {"type": "string"},
                    "valueExpression": {"type": "string"},
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
                "properties": {"expression": {"type": "string"}},
                "required": ["expression"],
            },
        ),
        _item(
            "Delay",
            "数据",
            "延时",
            {
                "type": "object",
                "properties": {"durationMs": {"type": "integer", "minimum": 0}},
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
                    "condition": {"type": "string"},
                    "timeoutMs": {"type": "integer", "minimum": 1},
                    "pollIntervalMs": {"type": "integer", "minimum": 10},
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
                    "toolContractRevision": {"type": "string"},
                    "inputSchemaHash": {"type": "string"},
                    "arguments": {"type": "object"},
                    "timeoutMs": {"type": "integer", "minimum": 1},
                    "errorPolicy": {"type": "string", "enum": ["error", "fail"]},
                },
                "required": [
                    "hardwareId",
                    "toolName",
                    "toolContractRevision",
                    "inputSchemaHash",
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
                    "value": {},
                    "valueExpression": {"type": "string"},
                    "unit": {"type": "string"},
                    "metadata": {"type": "object"},
                    "verdict": {
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


def _value_schema(extra: Record) -> Record:
    return {
        "type": "object",
        "properties": {
            "actual": {},
            "actualExpression": {"type": "string"},
            **extra,
        },
        "additionalProperties": True,
    }
