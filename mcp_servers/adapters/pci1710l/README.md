# PCI-1710L MCP 适配器

服务标识：`PCI1710L_MCP`。包 `hh_adapter_pci1710l`，入口 `python -m hardwareharness_device_sdk --adapter hh_adapter_pci1710l`。

一个服务进程只管理一个硬件。公共工具（`get_server_info`、`list_hardware`、`get_hardware_info`、`get_pinout`、`list_streams`、`get_panel`、`<prefix>_stream_read/start/stop`）和信封格式由 SDK 提供，见 `mcp_servers/README.md`。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- AI/DI/DO 均使用 0 基通道 0–15；先 `configure_ai`，后 `read_voltage`。
- `signal_type`：0=SingleEnded，1=Differential。差分接法和参考地必须与手册对应；驱动会拒绝硬件不支持的配置。
- `value_range`：1=±10 V，2=±5 V，3=±2.5 V，4=±1.25 V，12=±0.625 V；7=0–10 V，8=0–5 V，9=0–2.5 V，10=0–1.25 V。
- `read_voltage` 是 ADC 样本，DI 是输入采样；DO 回读是控制状态，不证明负载端电压。
- `safe_state` 应用当前已打开会话的 `effectiveSafeDoMask`，未打开时查询返回启动配置；安全掩码可以非零。

## 流与面板

- 流：`ai0`–`ai15` 电压采样（需先 `configure_ai`，否则 `status: not_configured`）、`di` 16 位位图、`do` 控制回读。采样只在有订阅或 `pci1710l_stream_start` 后进行，走设备锁。
- dry-run 下 AI 默认读 0.0 V；`HARDWARE_DRY_RUN_AI_NOISE=1` 时返回带噪声的演示值。
- 面板模板：AI readout、DI lamp、DO toggle、`configure_ai` 表单、`safe_state` 按钮。

## 构建、测试与部署

适配器基于 `hardwareharness-device-sdk`（`mcp_servers/sdk`）。本地测试不访问硬件：

```powershell
cd mcp_servers
.\test.ps1 -Target pci1710l                 # pytest + dry-run 合规检查
uv run python tools\assemble.py pci1710l    # 生成 dist\pci1710l\ 部署包
```

部署到台架必须由人执行 `.\deploy.ps1 -Server pci1710l`。远端 `server.json`（身份、端口、token、`settings`）和 `app\native\build\` 下已编译的厂商 CLI 不会被部署覆盖。
