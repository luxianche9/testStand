# PCI-1762 MCP 适配器

服务标识：`PCI1762_MCP`。包 `hh_adapter_pci1762`，入口 `python -m hardwareharness_device_sdk --adapter hh_adapter_pci1762`。

一个服务进程只管理一个硬件。公共工具（`get_server_info`、`list_hardware`、`get_hardware_info`、`lease_*` 心跳租约、`<prefix>_stream_read`）、信封格式、`/device` 声明（身份、说明、图片、引脚、流、能力）、`/assets/{path}` 和 `/streams/{id}` 数据通道由 SDK 提供，见 `mcp_servers/README.md`。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- 继电器/DI 为 0 基通道 0–15；`closed=true` 为线圈吸合。
- `set_bank(mask)` 的 bit0 对应 RELAY0。底层按两个 8 位端口先后写入，不保证整卡原子切换；失败可能有部分动作。
- `read_bit(kind=DI)` 读取输入；`RELAY` 读取线圈控制状态，`DO` 为兼容别名。回读不测量触点电阻。
- `safe_state` 释放全部线圈并检查控制回读。`all_open` 不证明外部触点或负载已隔离；失败必须检查现状。

## 流

- `di`（bits，`width: 16`，`bitLabels` IDI0–IDI15，`kind: "measured"`）：16 位输入位图，有人订阅时采样（`settings.bitRateHz`，默认 20 Hz），仅变化时发布。
- `relay`（bits，`width: 16`，`bitLabels` R0–R15）：每次 `set_relay` / `set_bank` / `safe_state` 后立即读回线圈控制位图并发布（写失败也发布实际回读）；不是触点通断测量。
- 位图用 hwcli 的 `read_mask` 命令一次读取；打开时探测，旧版 hwcli 不支持则退回 16 次 `read_bit`（重新编译 `native/` 以获得单次读取）。

## 图片

`assets/appearance.svg`（板卡示意轮廓）和 `assets/ports/CN1.svg`（62 针 D-sub 引脚图）由 `pinout.py` 的 `appearance_diagram()`、`port_diagram()` 从引脚数据生成，是示意图而非照片；连接器视向（插合面/焊接面）未核实。修改引脚数据后用这两个函数重新生成文件，测试 `test_shipped_assets_match_pinout` 保证文件与数据一致。

## 构建、测试与部署

适配器基于 `hardwareharness-device-sdk`（`mcp_servers/sdk`）。本地测试不访问硬件：

```powershell
cd mcp_servers
.\test.ps1 -Target pci1762                 # pytest + dry-run 合规检查
```

部署到台架由人在 HardwareHarness 终端的设备页发起（电脑上的“部署服务”，已部署服务的“升级 / 卸载”），维护者也可用 `.\deploy.ps1`（参数见 `mcp_servers/README.md`）；终端先打包再部署，失败自动回滚。远端 `server.json`（身份、端口、token、`settings`）和 `native\build\`（旧安装为 `app\native\build\`）下已编译的厂商 CLI 不会被部署覆盖。
