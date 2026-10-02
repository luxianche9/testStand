# PCI-6208V MCP 适配器

服务标识：`PCI6208V_MCP`。包 `hh_adapter_pci6208v`，入口 `python -m hardwareharness_device_sdk --adapter hh_adapter_pci6208v`。

一个服务进程只管理一个硬件。公共工具（`get_server_info`、`list_hardware`、`get_hardware_info`、`lease_*` 心跳租约、`<prefix>_stream_read`）、信封格式、`/device` 声明（身份、说明、图片、引脚、流、能力）、`/assets/{path}` 和 `/streams/{id}` 数据通道由 SDK 提供，见 `mcp_servers/README.md`。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- AO 为 0 基通道 0–7；`set_voltage` 接受有限的 [-10,10] V，越界直接拒绝，不截断后写入。
- `read_last` 只返回当前打开会话最后成功写入的软件影子；该接口没有 ADC 回读。无写入记录时失败，不推断物理电压。
- `get_hardware_info.capabilityDetails.effectiveSafeVolts` 是实际会话安全配置；`safe_state` 将全部 8 路设置为此值，可能非 0 V。
- 写入成功表示驱动接受，物理输出和接线仍须独立测量。安全操作失败时 `error.details` 保留失败通道。
- 板卡没有 FIFO 和硬件时钟，`set_waveform` 使用 SDK 软件波形（`mode: "software"`）：服务线程在 `io_lock` 下以最多 200 次/秒写入，形状 sine/square/triangle/sawtooth/dc，频率 ≤20 Hz（每周期至少 10 点），`offset ± amplitude` 必须在 [-10,10] V 内，时序抖动约 ±5 ms。`startAt`（服务时间，见 `/time`）用于同步启动。`stop_waveform` 停止并保持 `holdValue`（缺省为波形 offset）。`set_voltage`、`safe_state`、关闭和任何租约结束都会先停止波形。能力见 `capabilityDetails.waveform`。
- 波形是否达到目标只能由独立测量判断（例如 PCI-1710L AI），服务不做判定。

## 流

- `ao0`–`ao7`（scalar，`unit: "V"`，`kind: "setpoint"`）：每次成功写入（含 `safe_state` 和每个软件波形点）即发布软件影子，记录带调用的 `op`；不访问硬件，也不是测量值。

## 图片

`assets/appearance.svg`（板卡示意轮廓）和 `assets/ports/CN1.svg`（37 针 D-sub 引脚图）由 `pinout.py` 的 `appearance_diagram()`、`port_diagram()` 从引脚数据生成，是示意图而非照片；连接器视向（插合面/焊接面）未核实。修改引脚数据后重新生成：

```powershell
uv run python -c "from hh_adapter_pci6208v.pinout import *; open('adapters/pci6208v/src/hh_adapter_pci6208v/assets/ports/CN1.svg','w',newline='\n').write(port_diagram(pinout('X')).svg)"
```

测试 `test_shipped_assets_match_pinout` 保证文件与数据一致。

## 构建、测试与部署

适配器基于 `hardwareharness-device-sdk`（`mcp_servers/sdk`）。本地测试不访问硬件：

```powershell
cd mcp_servers
.\test.ps1 -Target pci6208v                 # pytest + dry-run 合规检查
```

部署到台架由人在 HardwareHarness 终端的设备页发起（电脑上的“部署服务”，已部署服务的“升级 / 卸载”），维护者也可用 `.\deploy.ps1`（参数见 `mcp_servers/README.md`）；终端先打包再部署，失败自动回滚。远端 `server.json`（身份、端口、token、`settings`）和 `native\build\`（旧安装为 `app\native\build\`）下已编译的厂商 CLI 不会被部署覆盖。
