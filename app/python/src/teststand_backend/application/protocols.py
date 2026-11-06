"""Protocol binding operations: which ICD decodes which raw device stream (design §6.4).

A binding makes the ICD's fields streams of the source hardware (``<alias>.<message>.<field>``)
for the monitor, the Agent and every test plan. Bindings live in ``project.json`` and, like
other project edits, stay in the project buffer until the project is saved.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from teststand_backend.contracts.errors import app_error
from teststand_backend.contracts.operations import Tool, operation
from teststand_backend.contracts.projects import (
    parse_protocols_update_input,
    protocol_operation_schema,
)
from teststand_backend.contracts.validation import array, obj

from .authorization import Authorizer, Json

if TYPE_CHECKING:
    from teststand_backend.devices import DeviceCatalogService, DeviceService
    from teststand_backend.projects.project_service import ProjectService
    from teststand_backend.projects.protocol_bindings import ProjectProtocols
    from teststand_backend.wiring.project_wiring_service import ProjectWiringService


class ProtocolsApplication:
    def __init__(
        self,
        authorizer: Authorizer,
        projects: ProjectService,
        protocols: ProjectProtocols,
        wiring: ProjectWiringService,
        catalog: DeviceCatalogService,
        devices: DeviceService,
    ) -> None:
        self.authorizer, self.projects, self.protocols = authorizer, projects, protocols
        self.wiring, self.catalog, self.devices = wiring, catalog, devices

    @operation(
        "protocols.list",
        capability="projects.read",
        risk="read",
        profiles=("plan", "explore"),
        idempotency="natural",
    )
    def bindings(self, context: Json) -> list[Json]:
        """The project's protocol bindings: ICD, alias and source stream; ``ok`` with the field
        streams each derives, or ``error`` when its ICD is missing or invalid. None without a
        project."""
        return self.protocols.describe()

    @operation(
        "protocols.update",
        capability="projects.manage",
        risk="write",
        profiles=("plan", "explore"),
        idempotency="natural",
        confirm=True,
    )
    def update(self, context: Json, input: Json) -> list[Json]:
        """Apply ``operations`` in order: ``add`` a binding (alias, icd, source), ``update`` the
        one with that alias (icd and / or source), ``remove`` it. The ICD must be a valid file of
        the project, the source a managed hardware's ``bytes`` / ``frames`` stream of the type
        the ICD decodes, and the alias unique. Stays in the project buffer until the project is
        saved. Returns every binding with its state."""
        request = parse_protocols_update_input(input)
        bindings = self.projects.protocols()
        for change in request["operations"]:
            alias = change["alias"]
            index = next((i for i, item in enumerate(bindings) if item["alias"] == alias), None)
            if change["op"] == "add":
                if index is not None:
                    raise app_error("conflict", f"Protocol alias {alias} is already bound")
                if "icd" not in change or "source" not in change:
                    raise app_error("invalid_argument", "add needs icd and source")
                bindings.append({"icd": change["icd"], "alias": alias, "source": change["source"]})
                continue
            if index is None:
                raise app_error("not_found", f"No protocol binding {alias}", {"alias": alias})
            if change["op"] == "remove":
                bindings.pop(index)
                continue
            bindings[index] = {
                **bindings[index],
                **{key: change[key] for key in ("icd", "source") if key in change},
            }
        for binding in bindings:
            self._check(binding)
        self.projects.update_protocols(bindings)
        self.wiring.notify_project_changed()
        return self.protocols.describe()

    def _check(self, binding: Json) -> None:
        icd = self.protocols.icds.load(binding["icd"])
        source = binding["source"]
        hardware = self.catalog.get_hardware(source["hardwareId"])
        if hardware["kind"] != "managed":
            raise app_error(
                "invalid_argument",
                f"{source['hardwareId']} is passive hardware and has no streams",
            )
        streams = self.devices.known_streams(source["hardwareId"])
        if streams is None:
            return  # never connected: checked again when a plan or the monitor uses it
        declared = {str(item.get("id")): str(item.get("type") or "") for item in streams}
        kind = declared.get(source["streamId"])
        if kind is None:
            raise app_error(
                "invalid_argument",
                f"{source['hardwareId']} has no stream {source['streamId']}",
            )
        if kind != icd.transport:
            raise app_error(
                "invalid_argument",
                f"ICD {icd.name} decodes {icd.transport} streams; {source['streamId']} is {kind}",
            )


PROTOCOL_TOOLS = [
    Tool(
        "list_protocol_bindings",
        "列出工程的协议绑定：哪份 ICD 解码哪台设备的哪条原始流（bytes/frames），别名 alias，"
        "以及它派生出的字段流 <alias>.<message>.<field>（在源设备上，像设备自己的流一样能"
        "显示、observe/expect、在测试步骤里引用）。ok=false 时 error 说明 ICD 缺失或无效。",
        obj({}, strict=True),
        {"type": "array", "items": {"type": "object"}},
        operation="protocols.list",
    ),
    Tool(
        "update_protocol_bindings",
        "增删改工程的协议绑定（操作员确认后生效）。operations 按顺序执行：add 新建（alias、"
        "icd、source{hardwareId, streamId}）、update 改某个 alias 的 icd 或 source、remove "
        "删除。ICD 必须是工程 icd/ 下有效的文件（先用 save_icd 写好），源流必须是受管硬件的 "
        "bytes/frames 流且与 ICD 的 transport 一致。绑定后字段流立即可用；save_project 前"
        "只在工程缓冲区。测试计划不再自带协议绑定，统一用这里的。",
        obj(
            {
                "operations": array(protocol_operation_schema, 1).describe(
                    "Binding changes, applied in order."
                )
            },
            strict=True,
        ),
        {"type": "array", "items": {"type": "object"}},
        operation="protocols.update",
        arguments=lambda value: {"input": value},
    ),
]
