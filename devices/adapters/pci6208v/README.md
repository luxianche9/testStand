# PCI-6208V 设备插件

包 `teststand_adapter_pci6208v`，设备类型 `pci6208v`（入口点组 `teststand.devices`），由 testStand 后端作为插件加载。`isolation = "subprocess"`：PCIS-DASK（`PCI-Dask64.dll`）加载时会写 stdout，所以设备在独立的子进程中运行，驱动输出进 stderr 日志，不会污染后端的启动握手；后端退出时子进程先 `safe_state` 再退出。

一个插件实例只管理一个硬件。公共工具（`get_device_info`、`list_hardware`、`get_hardware_info`、`<prefix>_stream_read`）、信封格式、`/device` 声明（身份、说明、引脚、流、能力）和流读取由 SDK 提供，见 `devices/README.md`。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- AO 为 0 基通道 0–7；`set_voltage` 接受有限的 [-10,10] V，越界直接拒绝，不截断后写入。
- `read_last` 只返回当前打开会话最后成功写入的软件影子；该接口没有 ADC 回读。无写入记录时失败，不推断物理电压。
- `get_hardware_info.capabilityDetails.effectiveSafeVolts` 是实际会话安全配置；`safe_state` 将全部 8 路设置为此值，可能非 0 V。
- 写入成功表示驱动接受，物理输出和接线仍须独立测量。安全操作失败时 `error.details` 保留失败通道。
- 板卡没有 FIFO 和硬件时钟，`set_waveform` 使用 SDK 软件波形（`mode: "software"`）：服务线程在 `io_lock` 下以最多 200 次/秒写入，形状 sine/square/triangle/sawtooth/dc，频率 ≤20 Hz（每周期至少 10 点），`offset ± amplitude` 必须在 [-10,10] V 内，时序抖动约 ±5 ms。`startAt`（服务时间，与流记录 `t` 同一时钟）用于同步启动。`stop_waveform` 停止并保持 `holdValue`（缺省为波形 offset）。`set_voltage`、`safe_state` 和关闭都会先停止波形。能力见 `capabilityDetails.waveform`。
- 波形是否达到目标只能由独立测量判断（例如 PCI-1710L AI），服务不做判定。

## 流

- `ao0`–`ao7`（scalar，`unit: "V"`，`kind: "setpoint"`）：每次成功写入（含 `safe_state` 和每个软件波形点）即发布软件影子，记录带调用的 `op`；不访问硬件，也不是测量值。


## 构建与测试

适配器基于 `teststand-device-sdk`（`devices/sdk`）。本地测试不访问硬件：

```powershell
cd devices
.\test.ps1 -Target pci6208v                 # pytest + dry-run 合规检查
```
