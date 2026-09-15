# CP-118U-I MCP 服务

服务标识：`CP118U_I_MCP`。

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

- 通道为 P1–P8，参数 `channel` 为 1–8；COM/PComm 映射从 `get_hardware_info` 的 `capabilityDetails.portMap` 读取。
- `configure_port` 只设置 UART 帧/流控。`mode` 是帧格式编码；RS-232/422/485 由实体 DIP 开关决定，当前软件无法探测。
- `write_text` 使用 UTF-8 且不追加换行；二进制或其他编码通过 `write_hex` 传精确字节。返回 `bytes` 仅为驱动接受数量，不证明对端收到。
- `read_rx` 返回自最后 clear/flush 以来的累计缓存，不消费；`max_bytes` 截取最早的前缀。`hex` 是原始证据，`text` 以 UTF-8 替换无效字节。
- 保留原有空读语义：`timeout_ms=0` 空读成功；正超时空读返回错误，空结果在 `error.details`。重复读取可能包含相同字节。
- `clear_rx`、`flush` 会丢弃证据；TX flush 可以丢弃待发送字节。
