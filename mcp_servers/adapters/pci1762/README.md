# PCI-1762 MCP 适配器

服务标识：`PCI1762_MCP`。包 `hh_adapter_pci1762`，入口 `python -m hardwareharness_device_sdk --adapter hh_adapter_pci1762`。

一个服务进程只管理一个硬件。公共工具（`get_server_info`、`list_hardware`、`get_hardware_info`、`get_pinout`、`list_streams`、`get_panel`、`<prefix>_stream_read/start/stop`）和信封格式由 SDK 提供，见 `mcp_servers/README.md`。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- 继电器/DI 为 0 基通道 0–15；`closed=true` 为线圈吸合。
- `set_bank(mask)` 的 bit0 对应 RELAY0。底层按两个 8 位端口先后写入，不保证整卡原子切换；失败可能有部分动作。
- `read_bit(kind=DI)` 读取输入；`RELAY` 读取线圈控制状态，`DO` 为兼容别名。回读不测量触点电阻。
- `safe_state` 释放全部线圈并检查控制回读。`all_open` 不证明外部触点或负载已隔离；失败必须检查现状。

## 流与面板

- 流：`di`、`relay` 16 位位图采样（`settings.bitRateHz`，默认 5 Hz）；`relay` 是线圈控制回读。
- 面板模板：`relay0`–`relay15` toggle（二次确认）、`relay_bank` 整字写入、DI lamp、`safe_state` 按钮。

## 构建、测试与部署

适配器基于 `hardwareharness-device-sdk`（`mcp_servers/sdk`）。本地测试不访问硬件：

```powershell
cd mcp_servers
.\test.ps1 -Target pci1762                 # pytest + dry-run 合规检查
uv run python tools\assemble.py pci1762    # 生成 dist\pci1762\ 部署包
```

部署到台架必须由人执行 `.\deploy.ps1 -Server pci1762`。远端 `server.json`（身份、端口、token、`settings`）和 `app\native\build\` 下已编译的厂商 CLI 不会被部署覆盖。
