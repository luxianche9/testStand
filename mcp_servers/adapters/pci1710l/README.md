# PCI-1710L 设备插件

包 `hh_adapter_pci1710l`，设备类型 `pci1710l`（入口点组 `hardwareharness.devices`），由 HardwareHarness 后端作为插件加载。

一个插件实例只管理一个硬件。公共工具（`get_device_info`、`list_hardware`、`get_hardware_info`、`<prefix>_stream_read`）、信封格式、`/device` 声明（身份、说明、引脚、流、能力）和流读取由 SDK 提供，见 `mcp_servers/README.md`。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- AI/DI/DO 均使用 0 基通道 0–15；先 `configure_ai`，后 `read_voltage`。
- `signal_type`：0=SingleEnded，1=Differential。差分接法和参考地必须与手册对应；驱动会拒绝硬件不支持的配置。
- `value_range`：1=±10 V，2=±5 V，3=±2.5 V，4=±1.25 V，12=±0.625 V；7=0–10 V，8=0–5 V，9=0–2.5 V，10=0–1.25 V。
- `read_voltage` 是 ADC 样本，DI 是输入采样；DO 回读是控制状态，不证明负载端电压。
- `safe_state` 应用当前已打开会话的 `effectiveSafeDoMask`，未打开时查询返回启动配置；安全掩码可以非零。

## 流

- `ai0`–`ai15`（scalar，`unit: "V"`，`kind: "measured"`）：一个扫描组，一次扫描读全部已配置通道并共享时间戳（`settings.aiRateHz`，默认 20 Hz）；未配置通道 `status: not_configured`。`read_voltage` 的读数也发布到对应流并带调用的 `op`。
- `di`（bits，`width: 16`，`bitLabels` DI0–DI15）：16 位输入位图，仅变化时发布（`settings.bitRateHz`，默认 20 Hz）。
- `do`（bits，`width: 16`，`bitLabels` DO0–DO15）：每次 `set_level` / `safe_state` 后立即读回控制位图并发布。
- 采样只在有订阅时进行，与工具调用共用设备锁。位图用 hwcli 的 `read_mask` 命令一次读取。
- dry-run 下 AI 默认读 0.0 V；`HARDWARE_DRY_RUN_AI_NOISE=1` 时返回带噪声的演示值。


## 构建与测试

适配器基于 `hardwareharness-device-sdk`（`mcp_servers/sdk`）。本地测试不访问硬件：

```powershell
cd mcp_servers
.\test.ps1 -Target pci1710l                 # pytest + dry-run 合规检查
```

真机模式使用 DAQNavi 桥接程序 `hwcli_pci1710l.exe`：源码在 `mcp_servers/native/hwcli_pci1710l.cpp`，用 `python mcp_servers/native/build.py`（MinGW-w64 g++ + DAQNavi SDK 头文件）编译到本包的 `bin/` 下，适配器默认从那里启动；也可用 `settings.hwcliPath` 或环境变量 `PCI1710L_HWCLI_PATH` / `HWCLI_PATH` 指定。
