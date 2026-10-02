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
                    "encode": {
                        "type": "object",
                        "title": "协议编码",
                        "description": "用 ICD 编码器生成帧，写入工具参数（§6.5）",
                        "properties": {
                            "icd": {"type": "string", "minLength": 1},
                            "message": {"type": "string", "minLength": 1},
                            "fields": {"type": "object"},
                            "argument": {"type": "string", "minLength": 1},
                        },
                        "required": ["icd", "message"],
                        "additionalProperties": False,
                    },
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
                    "anchor": {
                        "type": "string",
                        "title": "锚点名",
                        "description": "以本次调用的服务端完成时刻为锚点，供 Observe/Expect 引用",
                    },
                    "assertions": {
                        **_ASSERTIONS,
                        "description": "判定调用结果；metric 取 result.* / timing.* / arguments.*",
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
            "Observe",
            "判定",
            "观测窗口",
            {
                "type": "object",
                "description": "在锚点附近的时间窗口内统计数据流指标并判定",
                "properties": {
                    **_STREAM,
                    "window": {
                        "type": "object",
                        "title": "窗口",
                        "properties": {
                            "anchor": {"type": "string", "title": "锚点名"},
                            "startMs": {**_MS, "title": "起点偏移", "default": 0},
                            "endMs": {**_MS, "title": "终点偏移", "default": 100},
                        },
                        "required": ["anchor", "endMs"],
                    },
                    "assertions": _STREAM_ASSERTIONS,
                    "minSamples": {
                        "type": "integer",
                        "title": "最少样本数",
                        "minimum": 1,
                        "default": 3,
                    },
                },
                "required": ["hardwareId", "streamId", "window", "assertions"],
            },
        ),
        _item(
            "Expect",
            "判定",
            "期望事件",
            {
                "type": "object",
                "description": "锚点后 offsetMs 起、withinMs 内数据流出现匹配的记录则通过",
                "properties": {
                    **_STREAM,
                    "anchor": {"type": "string", "title": "锚点名"},
                    "offsetMs": {**_MS, "title": "起点偏移", "default": 0},
                    "withinMs": {**_MS, "title": "时限", "exclusiveMinimum": 0, "default": 1000},
                    "match": {**_MATCH, "title": "匹配条件"},
                    "capture": _CAPTURE,
                },
                "required": ["hardwareId", "streamId", "anchor", "withinMs", "match"],
            },
        ),
        _item(
            "Guard",
            "判定",
            "守护条件",
            {
                "type": "object",
                "description": "子步骤执行期间数据流必须一直满足 condition；违反时停止子步骤",
                "properties": {
                    **_STREAM,
                    "condition": {**_MATCH, "title": "保持条件"},
                    "onViolation": {
                        "type": "string",
                        "title": "违反时",
                        "enum": ["abort", "fail"],
                        "default": "abort",
                        "description": "abort：中止整个运行（仍执行清理）；fail：本步骤失败后继续",
                    },
                },
                "required": ["hardwareId", "streamId", "condition"],
            },
            container=True,
        ),
        _item(
            "ManualCheck",
            "判定",
            "人工判定",
            {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "title": "提示"},
                    "images": {
                        "type": "array",
                        "title": "参考图片",
                        "items": {"type": "string"},
                    },
                    "options": {
                        "type": "array",
                        "title": "选项",
                        "description": "默认：通过 / 不通过 / 无法判断",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string", "title": "文字"},
                                "verdict": {
                                    "type": "string",
                                    "title": "判定",
                                    "enum": ["pass", "fail", "inconclusive"],
                                },
                            },
                            "required": ["label", "verdict"],
                        },
                    },
                    "requireNote": {"type": "boolean", "title": "必须填写说明", "default": False},
                    "timeoutMs": {
                        "type": "integer",
                        "title": "超时",
                        "minimum": 1,
                        "x-hh-unit": "ms",
                        "description": "超时未答记为无法判断（operator_undecided）",
                    },
                },
                "required": ["prompt"],
            },
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
                    "evidenceType": {
                        "title": "证据等级",
                        "type": "string",
                        "enum": ["T1", "T2", "T3", "P", "M", "S"],
                        "description": "T1 独立测量 · T2 仪器自测 · T3 仪器精密结果 · "
                        "P 协议回报 · M 人工 · S 设定值影子（不能判定）",
                    },
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


_MS = {"type": "number", "x-hh-unit": "ms"}
_STREAM = {
    "hardwareId": {"type": "string", "title": "设备"},
    "streamId": {"type": "string", "title": "数据流"},
}
_ASSERTIONS = {
    "type": "array",
    "title": "断言",
    "minItems": 1,
    "items": {
        "type": "object",
        "properties": {
            "metric": {"type": "string", "title": "指标"},
            "op": {
                "type": "string",
                "title": "比较",
                "enum": [
                    "lt",
                    "le",
                    "gt",
                    "ge",
                    "eq",
                    "ne",
                    "within",
                    "outside",
                    "matches",
                    "contains",
                ],
            },
            "value": {"title": "期望值"},
            "tolerance": {"title": "容差", "description": "数值或百分比，如 0.05 或 '1%'"},
        },
        "required": ["metric", "op", "value"],
    },
}
# Observe assertions also take the waveform parameters of §7.4 (streams/judge.py).
_STREAM_ASSERTIONS = {
    **_ASSERTIONS,
    "description": (
        "scalar/block 指标：mean min max pp rms std first last count，"
        "波形 freq(Hz) period duty(0..1) riseMs fallMs settleMs；"
        "riseMs/fallMs 按 10%–90% 计算，分辨率受采样间隔限制"
    ),
    "items": {
        **_ASSERTIONS["items"],  # type: ignore[dict-item]
        "properties": {
            **_ASSERTIONS["items"]["properties"],  # type: ignore[index]
            "threshold": {
                "type": "number",
                "title": "阈值",
                "description": "freq/period/duty 的判别电平，默认 (min+max)/2",
            },
            "hysteresis": {
                "type": "number",
                "title": "迟滞",
                "minimum": 0,
                "description": "阈值上下的迟滞带宽，默认峰峰值的 5%",
            },
            "low": {"type": "number", "title": "低电平", "description": "riseMs/fallMs 的 0%"},
            "high": {"type": "number", "title": "高电平", "description": "riseMs/fallMs 的 100%"},
            "target": {
                "type": "number",
                "title": "稳定目标",
                "description": "settleMs 的目标值，默认窗口内最后一个样本",
            },
            "band": {
                "title": "稳定带",
                "description": "settleMs 必填：目标 ± band，数值或百分比如 '2%'",
            },
        },
    },
}
_CAPTURE = {
    "type": "object",
    "title": "捕获",
    "description": (
        "从匹配到的记录中提取值，后续步骤以 steps.<id>.captures.<name> 引用；"
        "{regex, group?} 在 bytes 文本上匹配，{field: 'fields.code'} 取记录字段"
    ),
    "propertyNames": {"pattern": "^[A-Za-z_][A-Za-z0-9_]{0,63}$"},
    "additionalProperties": {
        "type": "object",
        "properties": {
            "regex": {"type": "string", "title": "正则"},
            "group": {"type": ["integer", "string"], "title": "分组", "default": 1},
            "field": {"type": "string", "title": "字段路径"},
        },
        "additionalProperties": False,
    },
}
_MATCH = {
    "type": "object",
    "description": (
        "scalar/block: {op: lt|le|gt|ge|eq|ne, value}；bits: {bit, level}；"
        "bytes: {dir?, pattern|hex}；frames: {dir?, data?, mask?}"
    ),
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
