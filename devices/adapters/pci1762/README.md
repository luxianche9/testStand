# PCI-1762 设备插件

包 `teststand_adapter_pci1762`，设备类型 `pci1762`（入口点组 `teststand.devices`），由 testStand 后端作为插件加载。

一个插件实例只管理一个硬件。公共工具（`get_device_info`、`list_hardware`、`get_hardware_info`、`<prefix>_stream_read`）、信封格式、`/device` 声明（身份、说明、引脚、流、能力）和流读取由 SDK 提供，见 `devices/README.md`。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- 继电器/DI 为 0 基通道 0–15；`closed=true` 为线圈吸合。
- `set_bank(mask)` 的 bit0 对应 RELAY0。底层按两个 8 位端口先后写入，不保证整卡原子切换；失败可能有部分动作。
- `read_bit(kind=DI)` 读取输入；`RELAY` 读取线圈控制状态，`DO` 为兼容别名。回读不测量触点电阻。
- `safe_state` 释放全部线圈并检查控制回读。`all_open` 不证明外部触点或负载已隔离；失败必须检查现状。

## 流

- `di`（bits，`width: 16`，`bitLabels` IDI0–IDI15，`kind: "measured"`）：16 位输入位图，有人订阅时采样（`settings.bitRateHz`，默认 20 Hz），仅变化时发布。
- `relay`（bits，`width: 16`，`bitLabels` R0–R15）：每次 `set_relay` / `set_bank` / `safe_state` 后立即读回线圈控制位图并发布（写失败也发布实际回读）；不是触点通断测量。
- 位图用 hwcli 的 `read_mask` 命令一次读取。继电器回读比写入晚几毫秒；另一块 DAQNavi 板卡刚打开后的约 2 秒内，写入会晚 1～3 秒才到板卡。桥接程序在每次写后等回读一致（最多 3 s）再应答，超时则该次写入报错。


## 构建与测试

适配器基于 `teststand-device-sdk`（`devices/sdk`）。本地测试不访问硬件：

```powershell
cd devices
.\test.ps1 -Target pci1762                 # pytest + dry-run 合规检查
```

真机模式使用 DAQNavi 桥接程序 `hwcli_pci1762.exe`：源码在 `devices/native/hwcli_pci1762.cpp`，用 `python devices/native/build.py`（MinGW-w64 g++ + DAQNavi SDK 头文件）编译到本包的 `bin/` 下，适配器默认从那里启动；也可用 `settings.hwcliPath` 或环境变量 `PCI1762_HWCLI_PATH` / `HWCLI_PATH` 指定。
