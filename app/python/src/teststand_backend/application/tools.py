"""Public MCP tools for devices, hardware, projects and wiring."""

from __future__ import annotations

import os
from typing import Any

from teststand_backend.contracts.devices import hardware_schema
from teststand_backend.contracts.errors import app_error
from teststand_backend.contracts.operations import PLATFORM_META, WHOLE, Tool
from teststand_backend.contracts.validation import (
    array,
    custom_issue,
    number,
    obj,
    string,
    union,
)
from teststand_backend.contracts.wiring import (
    pin_pair_schema,
    wiring_action_schema,
    wiring_task_status_schema,
)
from teststand_backend.util import clone

Record = dict[str, Any]

GLOSSARY = {
    "rootPath": "Existing absolute directory on this testStand host; this is the USER project, "
    "not the testStand installation.",
    "deviceId": "Copy deviceId from list_devices; one service binds one managed hardware object.",
    "lines": "Most recent service log lines, default 200, range 1–2000.",
    "hardwareId": "Copy the exact hardwareId from the hardware catalog; do not infer it from "
    "a label.",
    "hardware": "Complete local hardware definition matching this schema. This does not modify "
    "physical hardware.",
    "formatVersion": "formatVersion in the hardware record; preserve the schema type and "
    "existing identifier values.",
    "label": "Human-readable label; IDs, not labels, identify hardware.",
    "kind": "Hardware category: managed devices belong to an MCP service; passive objects "
    "contain local reference data.",
    "ports": "Physical connector definitions. Preserve stable IDs already referenced by wiring.",
    "portId": "Exact local portId in the hardware definition, not the canonical endpointRef.",
    "name": "Human-readable port name.",
    "pins": "Physical pins of this port; pinId values are referenced by wiring pin pairs.",
    "pinId": "Stable local pin identifier copied into wiring pin pairs.",
    "position": "position in the pins record; preserve the schema type and existing identifier "
    "values.",
    "portA": "Copy ports[].endpointRef from get_hardware_definition, or supply exact "
    "hardwareId/portId. Same-port wiring needs distinct pin pairs.",
    "portB": "Second canonical endpointRef or structured endpoint; same-port loopback is "
    "allowed for distinct pins.",
    "a": "Exact pinId on portA, copied from that port's pins list.",
    "b": "Exact pinId on portB, copied from that port's pins list.",
    "action": "connect or disconnect requests human work; it never moves a cable automatically.",
    "timeoutMs": "Pending wiring task expiration in milliseconds; default 86400000 (one day), "
    "range 1000..604800000.",
    "wiringTaskId": "ID returned by request_wiring_task; valid only in this application session.",
    "message": "Optional reason recorded on the task; cancellation does not undo physical wiring.",
    "status": "Filter by the exact lifecycle status; a successful program exit is not a test "
    "verdict.",
    "limit": "Maximum records in this response; use pagination or a narrower filter for more.",
    "signals": "Logical signals a passive part (unit under test, fixture) offers; never tied to "
    "pins. Devices get their signals from their plugin's streams and must leave this empty.",
    "signalId": "Stable signal id, 1-64 of [A-Za-z0-9_.-]; the signal view links to it.",
    "type": "Signal type: scalar, bits, bytes or frames, as the device stream that carries it.",
    "direction": "From the part's side: input (driven by a device), output (measured by a device) "
    "or bidirectional (a bus).",
    "unit": "Physical unit of a scalar signal, e.g. V.",
    "width": "Number of bit lines of a bits signal, 1-64 (default 1).",
    "bitLabels": "One name per bit line of a bits signal.",
}


def _object(properties: Record, required: list[str] | None = None) -> Record:
    return {"type": "object", "properties": properties, "required": required or []}


def _array(items: Record) -> Record:
    return {"type": "array", "items": items}


_STRING, _INTEGER, _BOOLEAN = {"type": "string"}, {"type": "integer"}, {"type": "boolean"}
_PROJECT = _object(
    {
        "rootPath": _STRING,
        "path": _STRING,
        "dirty": _BOOLEAN,
        "file": _object(
            {
                "projectId": _STRING,
                "name": _STRING,
                "wiring": _object({"connections": _array(_object({}))}),
                "signals": _object({"nodes": _array(_object({})), "links": _array(_object({}))}),
            }
        ),
    },
    ["rootPath", "path", "dirty", "file"],
)
_STATE = _object(
    {"state": _STRING, "checkedAt": _STRING, "message": _STRING},
    ["state"],
)
_SERVICE = _object({"deviceId": _STRING, "transport": _STATE}, ["deviceId", "transport"])
_HARDWARE = _object(
    {
        "hardwareId": _STRING,
        "label": _STRING,
        "kind": {"enum": ["managed", "passive"]},
        "deviceId": _STRING,
        "ports": _array(
            _object(
                {
                    "portId": _STRING,
                    "name": _STRING,
                    "endpointRef": _STRING,
                    "endpoint": _object(
                        {"hardwareId": _STRING, "portId": _STRING}, ["hardwareId", "portId"]
                    ),
                    "pins": _array(
                        _object(
                            {"pinId": _STRING, "position": _INTEGER, "label": _STRING},
                            ["pinId", "position", "label"],
                        )
                    ),
                },
                ["portId", "pins"],
            )
        ),
    },
    ["hardwareId", "kind", "ports"],
)
_TASK = _object(
    {
        "wiringTaskId": _STRING,
        "status": {"enum": list(wiring_task_status_schema.options["values"])},
        "action": {"enum": ["connect", "disconnect"]},
        "portA": _STRING,
        "portB": _STRING,
        "pins": _array(_object({"a": _STRING, "b": _STRING}, ["a", "b"])),
        "hardwareIds": _array(_STRING),
        "warnings": _array(_STRING),
        "requestedAt": _STRING,
        "expiresAt": _STRING,
        "message": _STRING,
    },
    ["wiringTaskId", "status", "portA", "portB", "pins"],
)

_EMPTY = obj({}, strict=True)
_ROOT = obj(
    {
        "rootPath": string(1).refine(
            lambda value: (
                [] if os.path.isabs(value) else [custom_issue("rootPath must be absolute")]
            )
        )
    },
    strict=True,
)
_DEVICE_ID = obj({"deviceId": string(1)}, strict=True)
_HARDWARE_ID = obj({"hardwareId": string(1)}, strict=True)
_WIRING_TASK_ID = obj({"wiringTaskId": string(1)}, strict=True)
_ENDPOINT = union(string(1), obj({"hardwareId": string(1), "portId": string(1)}, strict=True))


def _with_endpoints(hardware: Record) -> Record:
    result = clone(hardware)
    for port in result.get("ports", []):
        port["endpointRef"] = f"{result['hardwareId']}.{port['portId']}"
        port["endpoint"] = {"hardwareId": result["hardwareId"], "portId": port["portId"]}
    return result


def _no_project_switch(app: Any, context: Record) -> None:
    if app.system.dashboard(context)["execution"]["state"] != "idle":
        raise app_error("conflict", "Finish the active execution before switching projects")
    if (app.projects.document(context) or {}).get("dirty"):
        raise app_error("conflict", "Save the current project before switching projects")


def _hardware_list(items: list[Record]) -> list[Record]:
    return [_with_endpoints(item) for item in items]


def _wiring_request(value: Record) -> Record:
    value = dict(value)
    for key in ("portA", "portB"):
        if isinstance(value[key], dict):
            value[key] = f"{value[key]['hardwareId']}.{value[key]['portId']}"
    return {"input": value}


def _platform(*args: Any, **options: Any) -> Tool:
    return Tool(*args, **{**options, "meta": PLATFORM_META, "glossary": GLOSSARY})


PLATFORM_TOOLS = [
    _platform(
        "get_project",
        "读取当前打开工程的根目录、持久化文档、接线连接与未保存状态。用于确定工作区和已有连接；"
        "无工程时按返回状态先打开或初始化工程。接线列表和信号视图都不证明物理导通。",
        _EMPTY,
        {"anyOf": [_PROJECT, {"type": "null"}]},
        operation="projects.document",
    ),
    _platform(
        "initialize_project",
        "在指定的现有绝对目录创建并打开新 testStand 工程。已有工程、未保存改动或活跃执行会拒绝。"
        "不会自动配置接线或完成 Python 依赖初始化；成功后检查工程状态。",
        _ROOT,
        _PROJECT,
        operation="projects.initializeFolder",
        fields=("rootPath",),
        check=_no_project_switch,
    ),
    _platform(
        "open_project",
        "按本机绝对目录打开已有 testStand 工程。未保存改动和活跃执行会阻止切换。"
        "成功后重新读取工程和会话状态；不要假设上个工程的待办仍有效。",
        _ROOT,
        _PROJECT,
        operation="projects.openFolder",
        fields=("rootPath",),
        check=_no_project_switch,
    ),
    _platform(
        "save_project",
        "通过项目服务保存当前工程（接线列表与信号视图）。检查返回的 dirty 状态；"
        "保存记录不执行物理接线。"
        "Python 源文件的写入状态与工程文档的保存状态分别核对。",
        _EMPTY,
        _PROJECT,
        operation="projects.saveProject",
    ),
    _platform(
        "list_devices",
        "列出已登记设备（插件实例）、所绑定硬件及连接状态。用于选择 deviceId 与识别"
        "公开工具来源；设备在线不代表目标电路通过测试。",
        _EMPTY,
        _object(
            {
                "devices": _array(
                    _object(
                        {
                            "deviceId": _STRING,
                            "hardwareId": _STRING,
                            "enabled": _BOOLEAN,
                            "label": _STRING,
                            "type": _STRING,
                        },
                        ["deviceId"],
                    )
                ),
                "statuses": _array(_SERVICE),
            },
            ["devices", "statuses"],
        ),
        operation="devices.listDevicesWithStatus",
    ),
    _platform(
        "refresh_device",
        "重新连接一个已登记设备并刷新其状态与声明。offline 表示设备当前不可用（驱动、板卡或"
        "服务未就绪），不应解释为测试结果。",
        _DEVICE_ID,
        _SERVICE,
        operation="devices.refreshDevice",
        fields=("deviceId",),
        open_world=True,
    ),
    _platform(
        "list_managed_hardware",
        "列出平台管理的主动硬件及当前健康状态。用于选择 hardwareId；健康状态和执行资源可用状态"
        "应分别检查，不能由登记成功推断设备可用。",
        _EMPTY,
        _array(
            _object(
                {
                    "hardwareId": _STRING,
                    "deviceId": _STRING,
                    "state": _STRING,
                    "health": _STRING,
                    "lastError": {"type": ["object", "null"]},
                },
                ["hardwareId", "deviceId", "state", "health"],
            )
        ),
        operation="devices.listManagedHardware",
        result=_hardware_list,
    ),
    _platform(
        "list_hardware_catalog",
        "列出本地登记的主动/被动硬件定义、端口和引脚。用于查接线资料，不会测量设备。调用接线"
        "工具时复用规范端点引用，不自行拼接 ID。",
        _EMPTY,
        _array(_HARDWARE),
        operation="devices.listHardware",
        result=_hardware_list,
    ),
    _platform(
        "get_hardware_definition",
        "按 hardwareId 读取一份硬件定义及端口/引脚资料。区分厂商资料、人工录入和实时观测；"
        "本工具不验证实物版本或当前跳帽状态。",
        _HARDWARE_ID,
        _HARDWARE,
        operation="devices.getHardware",
        fields=("hardwareId",),
        result=_with_endpoints,
    ),
    _platform(
        "save_hardware_definition",
        "创建或更新一份本地硬件定义。影响目录和信号视图引用，不操作实物。必须按硬件定义 schema "
        "提交；修改已有端口/引脚 ID 前检查关联接线。",
        obj({"hardware": hardware_schema}, strict=True),
        _HARDWARE,
        operation="devices.saveHardware",
        fields=("hardware",),
    ),
    _platform(
        "remove_hardware_definition",
        "删除指定硬件的本地定义。不会卸载驱动或移除实物；删除前核对工程引用，检查返回结果。",
        _HARDWARE_ID,
        _object({"hardwareId": _STRING}, ["hardwareId"]),
        operation="devices.removeHardware",
        fields=("hardwareId",),
    ),
    _platform(
        "request_wiring_task",
        "创建人工 connect/disconnect 接线待办，返回 wiringTaskId 和状态；本调用不移动任何线缆。"
        "端点和 pinId 必须来自目录的规范引用。确认后更新项目连接记录，待办本身属于应用会话。",
        obj(
            {
                "portA": _ENDPOINT,
                "portB": _ENDPOINT,
                "pins": array(pin_pair_schema)
                .default([])
                .describe(
                    "Explicit pin mapping; a belongs to portA and b to portB. Empty is "
                    "permitted only for different ports."
                ),
                "action": wiring_action_schema,
                "timeoutMs": number(1000, 7 * 86_400_000, integer=True).default(86_400_000),
            },
            strict=True,
        ),
        _TASK,
        operation="wiring.requestTask",
        arguments=_wiring_request,
    ),
    _platform(
        "cancel_wiring_task",
        "取消尚未完成的接线待办。取消待办不会撤销已经插好的线，也不会自动断开已确认连接；"
        "检查返回的当前状态。",
        obj({"wiringTaskId": string(1), "message": string().optional()}, strict=True),
        _TASK,
        operation="wiring.cancelTask",
        fields=("wiringTaskId", "message"),
    ),
    _platform(
        "get_wiring_task",
        "读取本应用会话中的一个接线待办。返回状态、到期时间和结果；confirmed 是人工确认记录，"
        "不是电气测量。重启后任务可能不存在。",
        _WIRING_TASK_ID,
        _TASK,
        operation="wiring.getTask",
        fields=("wiringTaskId",),
    ),
    _platform(
        "list_wiring_tasks",
        "按状态列出当前会话最近的接线待办，limit默认100、最大500。列表为空不代表工程没有已保存"
        "连接；已有连接应查询 get_project。",
        obj(
            {
                "status": wiring_task_status_schema.optional(),
                "limit": number(1, 500, integer=True).default(100),
            },
            strict=True,
        ),
        _array(_TASK),
        operation="wiring.listTasks",
        fields=(WHOLE,),
    ),
]
