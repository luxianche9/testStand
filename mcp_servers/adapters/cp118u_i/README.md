# CP-118U-I MCP 适配器

服务标识：`CP118U_I_MCP`。包 `hh_adapter_cp118u_i`，入口 `python -m hardwareharness_device_sdk --adapter hh_adapter_cp118u_i`。

一个服务进程只管理一个硬件。公共工具（`get_server_info`、`list_hardware`、`get_hardware_info`、`<prefix>_stream_read/transact`）、信封格式、`/device` 声明（身份、说明、引脚、流、能力）和 `/streams/{id}` 数据通道由 SDK 提供，见 `mcp_servers/README.md`。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- 通道为 P1–P8，参数 `channel` 为 1–8；COM/PComm 映射从 `get_hardware_info` 的 `capabilityDetails.portMap` 读取。映射优先级：`portMap`（或 `MOXA_PORT_MAP`）> 显式 `basePort`（或 `MOXA_BASE_PORT`）+ 偏移 > Windows 注册表 `EnumMXSERMxserB00P00k` 的 `PortName` > COM3 + 偏移。Moxa 的 COM 号不一定连续（如 P3=COM8、P6=COM5）。
- `configure_port` 只设置 UART 帧/流控。`mode` 是帧格式编码；RS-232/422/485 由实体 DIP 开关决定，当前软件无法探测。
- `write_text` 使用 UTF-8 且不追加换行；二进制或其他编码通过 `write_hex` 传精确字节。返回 `bytes` 仅为驱动接受数量，不证明对端收到。
- `read_rx` 返回自最后 clear/flush 以来的累计缓存，不消费；`max_bytes` 截取最早的前缀。`hex` 是原始证据，`text` 以 UTF-8 替换无效字节。
- 保留原有空读语义：`timeout_ms=0` 空读成功；正超时空读返回错误，空结果在 `error.details`。重复读取可能包含相同字节。
- `clear_rx`、`flush` 会丢弃证据；TX flush 可以丢弃待发送字节。

## 流

- `serial1`–`serial8` 为 `bytes` 流，记录 `{t, dir: rx|tx|mark, data, note?, op?}`，`data` 为小写十六进制（`cp118u_stream_read` 额外附 `text`）。所有发送都经 `stream.send` 记 `tx`；`configure_port`、`clear_rx`、`flush` 写 `mark`（如 `configure_port baud=9600 8N1 flow=0`）。
- `configure_port` 前流状态为 `not_configured`；之后后台线程约每 `settings.rxPollMs`（默认 10 ms，上限 100 ms）读取 RX，缓冲上限 `settings.rxBufferBytes`（默认 1 MiB）；`read_rx` 超出缓冲时 `overflow=true`。RX 分块边界是轮询产物，不是帧边界。每次读返回（包括 `read_rx` 内的读取）都调用 `stream.idle()`，未配置的端口每次轮询也确认空闲，因此 watermark 最多落后当前时间一个轮询周期；`/device` 中流声明为 `{"id": "serialN", "type": "bytes", "writable": true}`。
- 每个串口流都注册了写入器，因此 SDK 提供 `cp118u_transact(streamId, data, encoding, expect, timeoutMs)`：发送并在期限内等匹配应答，未配置的端口报 `not_configured`。
- `cp118u_safe_state` 丢弃全部端口待发送 TX，保留 RX 证据；原服务没有安全工具，SDK 合规要求提供。
- dry-run 默认不产生 RX；设置 `HARDWARE_DRY_RUN_SERIAL_LOOPBACK=1` 让 TX 回环到 RX，便于无回环插头演示。


## 构建、测试与部署

适配器基于 `hardwareharness-device-sdk`（`mcp_servers/sdk`）。本地测试不访问硬件：

```powershell
cd mcp_servers
.\test.ps1 -Target cp118u_i                 # pytest + dry-run 合规检查
```

部署到台架由人在 HardwareHarness 终端的设备页发起（电脑上的“部署服务”，已部署服务的“升级 / 卸载”），维护者也可用 `.\deploy.ps1`（参数见 `mcp_servers/README.md`）；终端先打包再部署，失败自动回滚。远端 `server.json`（身份、端口、token、`settings`）和 `native\build\`（旧安装为 `app\native\build\`）下已编译的厂商 CLI 不会被部署覆盖。
