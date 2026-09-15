# PCI-1710L MCP 服务

服务标识：`PCI1710L_MCP`。

一个服务进程只管理一个主动硬件。发行版 Agent 通过公开 MCP 契约完成查询和调用，不需要驱动或 HH 源码。

## 公开契约

契约修订版 `2026-09-15.1`。所有公开工具提供用途、字段说明、约束、类型化输出和副作用 annotations。

- `get_server_info`：服务版本、启动/停机状态、非敏感有效配置和能力。
- `list_hardware`：恰好一个设备的身份与生命周期摘要。
- `get_hardware_info`：设备健康、通道范围、证据类型和有效安全值。
- `get_pinout(hardwareId, connector_id=None, offset=0, limit=None)`：静态参考，可按精确连接器标识筛选并分页针脚；`pagination.nextOffset` 为续页位置。省略筛选/分页保留完整结果。

接线参考不会探测实际线缆、拨码或连接器视角。未知硬件修订/驱动版本明确返回 unknown，不从板卡型号猜测。

## 返回与执行

直接 MCP 结构化结果保留 `{ok, data, meta}` 或 `{ok:false, error, meta}`，成功的可选字段不会被自动补 null，底层扩展证据不丢失。HH Agent 网关成功结果为 `{ok:true,data:<设备 data>}`；Python SDK 默认保留 MCP envelope，先检查 `isError` 和 `structuredContent.ok`，再读取 `structuredContent.data`。HH 的 `get_tool_contract` 提供当前版本的完整形状和示例。

设备 open 后可以直接调用操作；服务串行处理硬件动作。超时或错误不表示物理动作没有发生：保留原错误/部分结果，查询当前状态并取证后再决定下一步。服务安全收尾由 HH 管理；`hardwareharness_prepare_shutdown` 标记为 internal，不向 Agent 或业务 SDK 发布。

## 安装与维护

在服务目录运行 `install.ps1` 安装服务依赖，配置 `server.json` 中的身份、监听地址、端口和 token，然后使用 `start.ps1`、`status.ps1`、`stop.ps1`。设备厂商驱动及所需本机桥接程序必须已安装。token 不通过 MCP 配置摘要返回。

开发契约检查：安装 `app[test]`，设置 `HARDWAREHARNESS_SERVER_CONFIG` 指向本服务的配置，运行 `python -m pytest app/tests -q`。这些检查替换设备调用边界，验证协议/schema/错误路径，不访问真实设备，也不代表设备或 DUT 验收。

## 设备语义

- AI/DI/DO 均使用 0 基通道 0–15；先 `configure_ai`，后 `read_voltage`。
- `signal_type`：0=SingleEnded，1=Differential。差分接法和参考地必须与手册对应；驱动会拒绝硬件不支持的配置。
- `value_range`：1=±10 V，2=±5 V，3=±2.5 V，4=±1.25 V，12=±0.625 V；7=0–10 V，8=0–5 V，9=0–2.5 V，10=0–1.25 V。
- `read_voltage` 是 ADC 样本，DI 是输入采样；DO 回读是控制状态，不证明负载端电压。
- `safe_state` 应用当前已打开会话的 `effectiveSafeDoMask`，未打开时查询返回启动配置；安全掩码可以非零。
