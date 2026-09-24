"""Public MCP tools for devices, hardware, projects and wiring."""

from __future__ import annotations

import base64
import inspect
import os
from typing import Any

from hardwareharness_backend.contracts.devices import hardware_schema
from hardwareharness_backend.contracts.errors import app_error
from hardwareharness_backend.contracts.operations import PLATFORM_META, WHOLE, Tool
from hardwareharness_backend.contracts.validation import (
    array,
    custom_issue,
    number,
    obj,
    string,
    union,
)
from hardwareharness_backend.contracts.wiring import (
    pin_pair_schema,
    wiring_action_schema,
    wiring_task_status_schema,
)
from hardwareharness_backend.util import clone

Record = dict[str, Any]

GLOSSARY = {
    "rootPath": "Existing absolute directory on this HH host; this is the USER project, "
    "not the HH installation.",
    "computerId": "Copy computerId from list_remote_computers; not a hostname or SSH command.",
    "serverId": "Copy serverId from list_mcp_servers; one service binds one managed hardware "
    "object.",
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
    "portId": "Exact local portId in the hardware definition, not the canonical endpointRef. "
    "Omit for the hardware image.",
    "name": "Human-readable port name.",
    "pins": "Physical pins of this port; pinId values are referenced by wiring pin pairs.",
    "pinId": "Stable local pin identifier copied into wiring pin pairs.",
    "position": "position in the pins record; preserve the schema type and existing identifier "
    "values.",
    "imageAssetId": "Existing managed image asset identifier; use image tools to create or "
    "remove images.",
    "appearanceAssetId": "appearanceAssetId in the hardware record; preserve the schema type "
    "and existing identifier values.",
    "imageBase64": "PNG/JPEG/WebP bytes as base64 or a data URL; the entire gateway request is "
    "limited to 1 MiB.",
    "fileName": "Original image filename used as metadata/format hint, not a path to read.",
    "portA": "Copy ports[].endpointRef from get_hardware_definition, or supply exact "
    "hardwareId/portId. Same-port wiring needs distinct pin pairs.",
    "portB": "Second canonical endpointRef or structured endpoint; same-port loopback is "
    "allowed for distinct pins.",
    "a": "Exact pinId on portA, copied from that port's pins list.",
    "b": "Exact pinId on portB, copied from that port's pins list.",
    "action": "connect or disconnect requests human work; it never moves a cable automatically.",
    "timeoutMs": "Pending wiring task expiration in milliseconds; default 1800000, range "
    "1000–86400000. Does not expire work already in progress.",
    "wiringTaskId": "ID returned by request_wiring_task; valid only in this application session.",
    "message": "Optional reason recorded on the task; cancellation does not undo physical wiring.",
    "status": "Filter by the exact lifecycle status; a successful program exit is not a test "
    "verdict.",
    "limit": "Maximum records in this response; use pagination or a narrower filter for more.",
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
                "wiring": _object(
                    {"nodes": _array(_object({})), "connections": _array(_object({}))}
                ),
            }
        ),
    },
    ["rootPath", "path", "dirty", "file"],
)
_STATE = _object(
    {
        "state": _STRING,
        "checkedAt": _STRING,
        "latencyMs": _INTEGER,
        "message": _STRING,
        "serviceState": _STRING,
    },
    ["state"],
)
_SERVICE = _object(
    {"serverId": _STRING, "computerId": _STRING, "service": _STATE, "transport": _STATE},
    ["serverId", "service", "transport"],
)
_HARDWARE = _object(
    {
        "hardwareId": _STRING,
        "label": _STRING,
        "kind": {"enum": ["managed", "passive"]},
        "serverId": _STRING,
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
_COMPUTER_ID = obj({"computerId": string(1)}, strict=True)
_SERVER_ID = obj({"serverId": string(1)}, strict=True)
_HARDWARE_ID = obj({"hardwareId": string(1)}, strict=True)
_WIRING_TASK_ID = obj({"wiringTaskId": string(1)}, strict=True)
_ENDPOINT = union(string(1), obj({"hardwareId": string(1), "portId": string(1)}, strict=True))


def _with_endpoints(hardware: Record) -> Record:
    result = clone(hardware)
    for port in result.get("ports", []):
        port["endpointRef"] = f"{result['hardwareId']}.{port['portId']}"
        port["endpoint"] = {"hardwareId": result["hardwareId"], "portId": port["portId"]}
    return result


def _decode_image(value: str) -> bytes:
    trimmed = value.strip()
    payload = trimmed[trimmed.find(",") + 1 :] if trimmed.startswith("data:") else trimmed
    if not payload:
        raise app_error("invalid_argument", "imageBase64 is required")
    # Buffer.from(base64) accepts whitespace, URL alphabet and missing padding.
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_"
    filtered = "".join(character for character in payload.split("=")[0] if character in alphabet)
    filtered = filtered[: len(filtered) - (1 if len(filtered) % 4 == 1 else 0)]
    result = base64.b64decode(filtered + "=" * (-len(filtered) % 4), altchars=b"-_")
    if not result:
        raise app_error("invalid_argument", "imageBase64 is not valid base64")
    return result


def _switch_project(method: str) -> Any:
    async def call(app: Any, context: Record, value: Record) -> Any:
        if app.system.dashboard(context)["execution"]["state"] != "idle":
            raise app_error("conflict", "Finish the active execution before switching projects")
        if (app.projects.document(context) or {}).get("dirty"):
            raise app_error("conflict", "Save the current project before switching projects")
        return await getattr(app.projects, method)(context, value["rootPath"])

    return call


def _server_action(action: str) -> Any:
    def call(app: Any, context: Record, value: Record) -> Any:
        return app.devices.server_action(context, value["serverId"], action)

    return call


async def _list_hardware(app: Any, context: Record, method: str) -> list[Record]:
    items = getattr(app.devices, method)(context)
    if inspect.isawaitable(items):
        items = await items
    return [_with_endpoints(item) for item in items]


async def _get_hardware(app: Any, context: Record, value: Record) -> Record:
    hardware = app.devices.get_hardware(context, value["hardwareId"])
    if inspect.isawaitable(hardware):
        hardware = await hardware
    return _with_endpoints(hardware)


def _set_image(app: Any, context: Record, value: Record) -> Any:
    return app.devices.set_hardware_image_bytes(
        context,
        value["hardwareId"],
        value.get("portId"),
        _decode_image(value["imageBase64"]),
        value["fileName"],
    )


def _request_wiring(app: Any, context: Record, value: Record) -> Any:
    value = dict(value)
    for key in ("portA", "portB"):
        if isinstance(value[key], dict):
            value[key] = f"{value[key]['hardwareId']}.{value[key]['portId']}"
    return app.wiring.request_task(context, value)


def _platform(*args: Any, **options: Any) -> Tool:
    return Tool(*args, **{**options, "meta": PLATFORM_META, "glossary": GLOSSARY})


_READ: dict[str, Any] = {"read_only": True}
_EDIT: dict[str, Any] = {"destructive": True, "idempotent": False}
_REMOTE_READ: dict[str, Any] = {"read_only": True, "open_world": True}
_REMOTE_EDIT: dict[str, Any] = {"destructive": True, "idempotent": False, "open_world": True}

PLATFORM_TOOLS = [
    _platform(
        "get_project",
        "读取当前打开工程的根目录、持久化文档、接线连接与未保存状态。用于确定工作区和已有连接；"
        "无工程时按返回状态先打开或初始化工程。画布记录不证明物理导通。",
        _EMPTY,
        {"anyOf": [_PROJECT, {"type": "null"}]},
        operation="projects.document",
        **_READ,
    ),
    _platform(
        "initialize_project",
        "在指定的现有绝对目录创建并打开新 HH 工程。已有工程、未保存改动或活跃执行会拒绝。"
        "不会自动配置接线或完成 Python 依赖初始化；成功后检查工程状态。",
        _ROOT,
        _PROJECT,
        call=_switch_project("initialize_folder"),
        capability="projects.manage",
    ),
    _platform(
        "open_project",
        "按本机绝对目录打开已有 HH 工程。未保存改动和活跃执行会阻止切换。成功后重新读取工程和"
        "会话状态；不要假设上个工程的待办仍有效。",
        _ROOT,
        _PROJECT,
        call=_switch_project("open_folder"),
        capability="projects.manage",
    ),
    _platform(
        "save_project",
        "通过项目服务保存当前工程及画布文档。检查返回的 dirty 状态；保存记录不执行物理接线。"
        "Python 源文件的写入状态与工程文档的保存状态分别核对。",
        _EMPTY,
        _PROJECT,
        operation="projects.save_project",
        **_EDIT,
    ),
    _platform(
        "list_remote_computers",
        "列出已登记计算机与非敏感连接标识。把返回的 id 原样用于 computerId 参数查询状态；"
        "配置存在不保证主机在线。",
        _EMPTY,
        _array(
            _object(
                {
                    "id": _STRING,
                    "label": _STRING,
                    "address": _STRING,
                    "execution": _STRING,
                    "ssh": _object({"port": _INTEGER, "username": _STRING, "shell": _STRING}),
                },
                ["id", "label", "address", "ssh"],
            )
        ),
        operation="devices.list_computers",
        **_REMOTE_READ,
    ),
    _platform(
        "get_remote_computer_status",
        "查询一个已登记计算机的 SSH 可达性及托管 MCP 服务状态。computerId 从计算机列表复制；"
        "SSH 在线不等于硬件可操作。",
        _COMPUTER_ID,
        _object(
            {"computerId": _STRING, "ssh": _STATE, "servers": _array(_SERVICE)},
            ["computerId", "ssh", "servers"],
        ),
        operation="devices.get_computer_status",
        fields=("computerId",),
        **_REMOTE_READ,
    ),
    _platform(
        "list_mcp_servers",
        "列出已登记 MCP 服务、所绑定硬件及连接状态。用于选择 serverId 与识别公开工具来源；"
        "服务登记或连接成功不代表目标电路通过测试。",
        _EMPTY,
        _object(
            {
                "servers": _array(
                    _object(
                        {
                            "serverId": _STRING,
                            "hardwareId": _STRING,
                            "computerId": _STRING,
                            "enabled": _BOOLEAN,
                            "url": _STRING,
                            "transport": _STRING,
                        },
                        ["serverId"],
                    )
                ),
                "statuses": _array(_SERVICE),
            },
            ["servers", "statuses"],
        ),
        operation="devices.list_servers_with_status",
        **_READ,
    ),
    _platform(
        "get_remote_mcp_service",
        "刷新一个已登记 MCP 服务的进程和连接状态。用于核对启动、停止或重启结果；unknown "
        "表示尚无法确认，不应解释为停止或成功。",
        _SERVER_ID,
        _SERVICE,
        operation="devices.refresh_server",
        fields=("serverId",),
        **_REMOTE_READ,
    ),
    _platform(
        "start_remote_mcp_service",
        "按已配置生命周期启动服务，可能初始化设备和驱动。serverId 从服务列表复制。超时不代表"
        "未启动；先查询状态再决定下一步。",
        _SERVER_ID,
        _SERVICE,
        call=_server_action("start"),
        capability="devices.controlServers",
        idempotent=False,
        open_world=True,
    ),
    _platform(
        "stop_remote_mcp_service",
        "按服务的正常关闭流程停止 MCP 服务，可能应用设备安全状态并断开硬件。操作前核对活跃"
        "运行；成功与安全收尾结果分别检查。",
        _SERVER_ID,
        _SERVICE,
        call=_server_action("stop"),
        capability="devices.controlServers",
        **_REMOTE_EDIT,
    ),
    _platform(
        "restart_remote_mcp_service",
        "按已配置的正常关闭与启动流程重启 MCP 服务。可能改变设备会话和输出配置；超时后先查询"
        "状态，避免重复重启。",
        _SERVER_ID,
        _SERVICE,
        call=_server_action("restart"),
        capability="devices.controlServers",
        **_REMOTE_EDIT,
    ),
    _platform(
        "read_remote_mcp_logs",
        "读取指定 MCP 服务最近的日志，lines 默认200、范围1–2000，用于服务故障诊断。",
        obj(
            {"serverId": string(1), "lines": number(1, 2000, integer=True).default(200)},
            strict=True,
        ),
        _object({"lines": _array(_STRING), "truncated": _BOOLEAN}, ["lines", "truncated"]),
        operation="devices.read_server_logs",
        fields=("serverId", "lines"),
        **_REMOTE_READ,
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
                    "computerId": _STRING,
                    "serverId": _STRING,
                    "state": _STRING,
                    "health": _STRING,
                    "lastError": {"type": ["object", "null"]},
                },
                ["hardwareId", "serverId", "computerId", "state", "health"],
            )
        ),
        call=lambda app, context, value: _list_hardware(app, context, "list_managed_hardware"),
        capability="hardware.read",
        **_READ,
    ),
    _platform(
        "list_hardware_catalog",
        "列出本地登记的主动/被动硬件定义、端口和引脚。用于查接线资料，不会测量设备。调用接线"
        "工具时复用规范端点引用，不自行拼接 ID。",
        _EMPTY,
        _array(_HARDWARE),
        call=lambda app, context, value: _list_hardware(app, context, "list_hardware"),
        capability="hardware.read",
        **_READ,
    ),
    _platform(
        "get_hardware_definition",
        "按 hardwareId 读取一份硬件定义及端口/引脚资料。区分厂商资料、人工录入和实时观测；"
        "本工具不验证实物版本或当前跳帽状态。",
        _HARDWARE_ID,
        _HARDWARE,
        call=_get_hardware,
        capability="hardware.read",
        **_READ,
    ),
    _platform(
        "save_hardware_definition",
        "创建或更新一份本地硬件定义。影响目录和画布引用，不操作实物。必须按硬件定义 schema "
        "提交；修改已有端口/引脚 ID 前检查关联接线。",
        obj({"hardware": hardware_schema}, strict=True),
        _HARDWARE,
        operation="devices.save_hardware",
        fields=("hardware",),
        **_EDIT,
    ),
    _platform(
        "remove_hardware_definition",
        "删除指定硬件的本地定义及关联图片。不会卸载驱动或移除实物；删除前核对工程引用，检查"
        "返回结果。",
        _HARDWARE_ID,
        _object({"hardwareId": _STRING}, ["hardwareId"]),
        operation="devices.remove_hardware",
        fields=("hardwareId",),
        **_EDIT,
    ),
    _platform(
        "set_hardware_image",
        "为硬件外观或指定端口设置 PNG/JPEG/WebP 图片。imageBase64 是图片编码，portId 使用"
        "目录中的原值；此动作只修改资料图片。",
        obj(
            {
                "hardwareId": string(1),
                "portId": string(1).optional(),
                "imageBase64": string(1),
                "fileName": string().default(""),
            },
            strict=True,
        ),
        _HARDWARE,
        call=_set_image,
        capability="hardware.manage",
        **_EDIT,
    ),
    _platform(
        "remove_hardware_image",
        "移除指定硬件外观图或端口图；省略 portId 时作用于硬件外观图。不会删除硬件定义或改变"
        "物理接线。",
        obj({"hardwareId": string(1), "portId": string(1).optional()}, strict=True),
        _HARDWARE,
        operation="devices.remove_hardware_image",
        fields=("hardwareId", "portId"),
        **_EDIT,
    ),
    _platform(
        "add_managed_hardware_to_canvas",
        "幂等地将已登记主动硬件加入当前工程画布，已存在时返回 added=false。会改变工程未保存"
        "状态；不创建物理接线或测量结果。",
        _HARDWARE_ID,
        _object(
            {"added": _BOOLEAN, "node": _object({}), "dirty": _BOOLEAN},
            ["added", "node", "dirty"],
        ),
        operation="wiring.add_managed_hardware_to_canvas",
        fields=("hardwareId",),
        idempotent=True,
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
                "timeoutMs": number(1000, 86_400_000, integer=True).default(1_800_000),
            },
            strict=True,
        ),
        _TASK,
        call=_request_wiring,
        capability="wiring.request",
    ),
    _platform(
        "cancel_wiring_task",
        "取消尚未完成的接线待办。取消待办不会撤销已经插好的线，也不会自动断开已确认连接；"
        "检查返回的当前状态。",
        obj({"wiringTaskId": string(1), "message": string().optional()}, strict=True),
        _TASK,
        operation="wiring.cancel_task",
        fields=("wiringTaskId", "message"),
        **_EDIT,
    ),
    _platform(
        "get_wiring_task",
        "读取本应用会话中的一个接线待办。返回状态、到期时间和结果；confirmed 是人工确认记录，"
        "不是电气测量。重启后任务可能不存在。",
        _WIRING_TASK_ID,
        _TASK,
        operation="wiring.get_task",
        fields=("wiringTaskId",),
        **_READ,
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
        operation="wiring.list_tasks",
        fields=(WHOLE,),
        **_READ,
    ),
]
