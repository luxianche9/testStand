# PCI-6208V MCP 适配器

服务标识：`PCI6208V_MCP`。包 `hh_adapter_pci6208v`，入口 `python -m hardwareharness_device_sdk --adapter hh_adapter_pci6208v`。

一个服务进程只管理一个硬件。公共工具（`get_server_info`、`list_hardware`、`get_hardware_info`、`get_pinout`、`list_streams`、`get_panel`、`<prefix>_stream_read/start/stop`）和信封格式由 SDK 提供，见 `mcp_servers/README.md`。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- AO 为 0 基通道 0–7；`set_voltage` 接受有限的 [-10,10] V，越界直接拒绝，不截断后写入。
- `read_last` 只返回当前打开会话最后成功写入的软件影子；该接口没有 ADC 回读。无写入记录时失败，不推断物理电压。
- `get_hardware_info.capabilityDetails.effectiveSafeVolts` 是实际会话安全配置；`safe_state` 将全部 8 路设置为此值，可能非 0 V。
- 写入成功表示驱动接受，物理输出和接线仍须独立测量。安全操作失败时 `error.details` 保留失败通道。

## 流与面板

- 流：`ao0`–`ao7` 发布每次成功写入后的软件影子，不访问硬件，也不是测量值。
- 面板模板：每路 AO number（[-10,10] V，二次确认，显示值为已接受的写入）、`safe_state` 按钮。

## 构建、测试与部署

适配器基于 `hardwareharness-device-sdk`（`mcp_servers/sdk`）。本地测试不访问硬件：

```powershell
cd mcp_servers
.\test.ps1 -Target pci6208v                 # pytest + dry-run 合规检查
uv run python tools\assemble.py pci6208v    # 生成 dist\pci6208v\ 部署包
```

部署到台架必须由人执行 `.\deploy.ps1 -Server pci6208v`。远端 `server.json`（身份、端口、token、`settings`）和 `app\native\build\` 下已编译的厂商 CLI 不会被部署覆盖。
