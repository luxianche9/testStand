# CP-118U-I MCP 适配器

服务标识：`CP118U_I_MCP`。包 `hh_adapter_cp118u_i`，入口 `python -m hardwareharness_device_sdk --adapter hh_adapter_cp118u_i`。

一个服务进程只管理一个硬件。公共工具（`get_server_info`、`list_hardware`、`get_hardware_info`、`get_pinout`、`list_streams`、`get_panel`、`<prefix>_stream_read/start/stop`）和信封格式由 SDK 提供，见 `mcp_servers/README.md`。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- 通道为 P1–P8，参数 `channel` 为 1–8；COM/PComm 映射从 `get_hardware_info` 的 `capabilityDetails.portMap` 读取。
- `configure_port` 只设置 UART 帧/流控。`mode` 是帧格式编码；RS-232/422/485 由实体 DIP 开关决定，当前软件无法探测。
- `write_text` 使用 UTF-8 且不追加换行；二进制或其他编码通过 `write_hex` 传精确字节。返回 `bytes` 仅为驱动接受数量，不证明对端收到。
- `read_rx` 返回自最后 clear/flush 以来的累计缓存，不消费；`max_bytes` 截取最早的前缀。`hex` 是原始证据，`text` 以 UTF-8 替换无效字节。
- 保留原有空读语义：`timeout_ms=0` 空读成功；正超时空读返回错误，空结果在 `error.details`。重复读取可能包含相同字节。
- `clear_rx`、`flush` 会丢弃证据；TX flush 可以丢弃待发送字节。

## 流与面板

- 流：`serial1`–`serial8` 字节流，条目为 `{dir: rx|tx, bytes, hex, text}`。`configure_port` 后后台线程约每 `settings.rxPollMs`（默认 10 ms）读取 RX，缓冲上限 `settings.rxBufferBytes`（默认 1 MiB）；`read_rx` 超出缓冲时 `overflow=true`。
- `cp118u_safe_state` 丢弃全部端口待发送 TX，保留 RX 证据；原服务没有安全工具，SDK 合规要求提供。
- dry-run 默认不产生 RX；设置 `HARDWARE_DRY_RUN_SERIAL_LOOPBACK=1` 让 TX 回环到 RX，用于演示终端控件。
- 面板模板：每端口一个 terminal（流 + 文本/HEX 发送 + 端口配置）、`safe_state` 按钮。

## 构建、测试与部署

适配器基于 `hardwareharness-device-sdk`（`mcp_servers/sdk`）。本地测试不访问硬件：

```powershell
cd mcp_servers
.\test.ps1 -Target cp118u_i                 # pytest + dry-run 合规检查
uv run python tools\assemble.py cp118u_i    # 生成 dist\cp118u_i\ 部署包
```

部署到台架必须由人执行 `.\deploy.ps1 -Server cp118u_i`。远端 `server.json`（身份、端口、token、`settings`）和 `app\native\build\` 下已编译的厂商 CLI 不会被部署覆盖。
