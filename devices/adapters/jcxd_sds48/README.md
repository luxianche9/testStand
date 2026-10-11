# JCXD-SDS48-CPCI 设备插件

包 `teststand_adapter_jcxd_sds48`，设备类型 `jcxd_sds48`（入口点组 `teststand.devices`），由 testStand 后端作为插件加载。`isolation = "subprocess"`：厂商 `JC_SDS48.dll` 通过内核驱动直接访问板卡，崩溃只结束子进程；后端退出时子进程先 `safe_state`（全部释放）再退出。x64 DLL 随包在 `bin/`，台架上须已安装厂商内核驱动 `JC_SDS48`（设备管理器“Devices-JC → JCXD-SDS48-X”）。资料：JCXD-SDS48-X 用户手册 硬件 V2.0.0、软件 V2.0.0、厂商例程 demo_0。一个实例管一张卡，多张卡各建一个实例，用 `serialNumber` 区分。

一个插件实例只管理一个硬件。公共工具（`get_device_info`、`list_hardware`、`get_hardware_info`、`sds48_stream_read`）、信封格式、`/device` 声明（身份、说明、引脚、流、能力）和流读取由 SDK 提供，见 `devices/README.md`。插件只报告测量值和状态，不判定通过 / 失败。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- 继电器 0–47，单刀双掷：OT_COMn 公共端、OT_CLn 常闭、OT_OPn 常开。**通电**（驱动状态 1）= COM–OP 接通，**释放**（0）= COM–CL 接通。复位和 `safe_state` 全部释放。CON1 放 0–11、24–35，CON2 放 12–23、36–47，引脚见 `/device.pinout`。
- `set_relay(channel, energized)`、`set_relays(channels, energized)`：读当前寄存器、改指定位、整体写一次（`set_relays` 的几路同时动作），等 `settleMs` 后读回寄存器；读回与写入不一致即报错并在 `details.differ` 列出不一致的继电器。
- `read_relays`：驱动寄存器（`Switch_GetMultiStatus`），证据类型 controller_state。**寄存器不是触点测量**，触点粘连或不通只能通过测量发现。
- 手册未给出继电器动作时间，`settleMs` 默认 10 ms 是保守值，不是手册数据；换用已知规格的继电器时按规格改。
- 驱动的 `JC_SDS48_GetDevParInfo`（头文件 V2.0 的名字）返回 1，插件用手册里的 `JC_SDS48_Get_DevParInfo`（返回 0，内容相同）。
- `self_test`（只读，不动作继电器）：板卡信息返回码、板卡类型 0x5205、路数 48、序列号（与配置一致）、`GetDevSn` 与设备信息一致、驱动寄存器等于插件最后一次写入、逐路读回与整体读回一致。

## 流

- `relays`（bits，48 位，bit i = 继电器 i，`display: "switches"`，`kind: "measured"`）：打开时和每次写入后发布驱动寄存器的读回值（1 = COM–OP），记录带调用的 `op`。不采样。

## `settings`

| 键 | 默认 | 说明 |
|---|---|---|
| `serialNumber` | 无 | 板卡序列号。本台架两张：637797222（id 0）、637797221（id 1）。设了就在 id 0–7 里找这张卡 |
| `cardIndex` | `0` | 未设 `serialNumber` 时打开的板卡 id（按插槽顺序，换槽会变，建议用序列号） |
| `settleMs` | `10` | 写入后等待多久再读回、再返回，0–1000 ms |
| `dllPath` | 包内 `bin/JC_SDS48.dll` | 也可用环境变量 `JC_SDS48_DLL` |

## 现场验收（需要接线或万用表，由用户执行）

`self_test` 只证明插件与板卡寄存器一致，触点要实测。断开被测设备后任选一种：

**万用表（全部 48 路）**：对每一路 n，释放状态下量 OT_COMn–OT_CLn ≈ 0 Ω、OT_COMn–OT_OPn 开路；`set_relay(n, true)` 后反过来；`safe_state` 后恢复。

**用 MADS-3210 的 DIO 自动回环（抽测）**：MADS DIO0（C0-68）接 SDS48 OT_COMn，OT_OPn 接 MADS DIO1（C0-34），两卡 DGND 相连。MADS `configure_dio([0])`、`write_do(0, 0)`（DIO0 拉低）。释放时 `read_dio().inputs` 的 bit1 = 1（板上上拉，OP 悬空）；`set_relay(n, true)` 后 bit1 = 0；再把 OP 换成 OT_CLn 重复，结果相反。每个连接器至少抽测 2 路（如 CON1 的 0、35，CON2 的 12、47）。

记录序列号、每路的读数；任何一路不合格都不要接入被测设备。

## 构建与测试

适配器基于 `teststand-device-sdk`（`devices/sdk`）。本地测试不访问硬件：

```powershell
cd devices
.\test.ps1 -Target jcxd_sds48                 # pytest + 模拟器上的合规检查
```

交付给 testStand 用设备包：`python devices/pack.py jcxd_sds48` 生成 `devices/dist/jcxd_sds48-<版本>.tsdev`；在 testStand 测试台架点“+ → 添加设备…”选这个文件，先以模拟模式添加验证，再编辑为实物做空载验收。
