# LJ-CO-CPCI-8 设备插件

包 `teststand_adapter_lj_co8`，设备类型 `lj_co8`（入口点组 `teststand.devices`），由 testStand 后端作为插件加载。`isolation`：`inproc`。厂商驱动 `PXI4281.dll` 是 32 位 LabWindows/CVI 仪器驱动（基于 NI-VISA），64 位后端加载不了，所以经 32 位桥接程序 `bin/hwcli_lj_co8.exe`（源码 `devices/native/hwcli_lj_co8.cpp`，`python devices/native/build_x86.py` 用 MSVC x86 构建）调用；桥接程序本身是独立进程，驱动崩溃或打印都不影响后端。`PXI4281.dll` 随包放在 `bin/`（与厂商安装包里的文件逐字节相同）。资料：《LJ-CO-CPCI-8 用户手册》V1.0、`PXI4281_api.h`、厂商演示程序源码。

一个插件实例只管理一个硬件。公共工具（`get_device_info`、`list_hardware`、`get_hardware_info`、`self_test`、`co8_stream_read`）、信封格式、`/device` 声明（身份、说明、引脚、流、能力）和流读取由 SDK 提供，见 `devices/README.md`。插件只报告状态，不判定通过 / 失败。超时或错误不表示继电器没有动作：保留原错误，重新设置或测量后再决定下一步。

## 台架前提

- 32 位 NI-VISA 运行时（`visa32.dll`）和 LabWindows/CVI 运行时（`cvirte.dll`）：厂商安装包 `LJ-CO-CPCI-8_setup(x86)` 会装；装过 NI-VISA / LabVIEW 的电脑一般已有。
- 板卡驱动：手册 2.2.2 节，用 `DriverForWin\PXI-4281.inf` 安装（NI-VISA 向导生成的 INF，Windows 10 上须自签名目录文件；本台架已装为 `oem47.inf`）。装好后 VISA 能列出 `PXIx::y::INSTR` 资源。

## 设备语义

- 8 路独立电容 C0–C7（0 基）。第 n 路电容在 DB-37 的 `Chn In`（引脚 20+2n）和 `Chn Out`（引脚 3+2n）之间，19 脚 GND，其余 NC，见 `/device.pinout`（手册图 1-3）。
- `set_capacitance(channel, pf)`：5–1000 pF，分辨率 1 pF，精度 ±0.5 pF，最大承受功率 0.5 W。越界或非有限值在调用驱动前拒绝，不截断。电容由继电器切换电容阵列得到，出厂校准存在板卡上，由驱动自动套用。
- `set_all(pf)`：8 路设成同一个值，一次驱动调用（`PXI4281_capSetCapacitanceAll`）。失败时各路可能是旧值也可能是新值。
- 本卡没有电容回读：厂商演示里的控制寄存器 `0x100+4n` 在台架上实测不论设多少都读 0。工具结果、`read_last` 和流都是驱动接受的设定值（软件影子），不是测量值；本会话没设过的通道 `read_last` 失败。
- `safe_state`：8 路都设成 `safePf`（默认 1000 pF，即头文件 `PXI4281_DEF_CAP`，也是演示程序连接后显示的值）。无源电容没有“断开”状态，安全值按被测设备的要求在 `settings` 里改。
- 打开时按厂商演示调用 `PXI4281_init(resource, IDQuery=1, reset=1)`，随后 SDK 执行 `safe_state`。
- `self_test`（只读）：厂商自检 `PXI4281_self_test`、序列号（设了 `serialNumber` 时须一致）、驱动和 FPGA 版本可读。通过只说明插件和板卡对上了，不证明电容值，那要按下面的验收步骤测。
- 不开放厂商校准写入函数（`SetBias`、`SaveBias`、`SetStandBias`、`SetSN`、`WriteReg`）：误调会改写板卡上的出厂校准。

## 流

- `c0`–`c7`（scalar，`unit: "pF"`，`label: "C<n>"`，`kind: "setpoint"`）：每次成功设置（含 `set_all`、`safe_state`）在写路径上发布设定值，记录带调用的 `op`；不访问硬件，没有采样率。

## `settings`

| 键 | 默认 | 说明 |
|---|---|---|
| `serialNumber` | 无 | 板卡序列号（本台架 26092002）。设了就逐个打开 VISA 找到的卡，选序列号一致的那张；多卡时用它 |
| `resource` | 无 | VISA 资源名，如 `PXI13::13::INSTR`；设了就直接打开它。两者都不设时打开 VISA 找到的第一张卡 |
| `safePf` | `1000` | `safe_state` 写入的值，5–1000 pF |
| `dllPath` | 包内 `bin/PXI4281.dll` | 另用一份厂商 DLL 时指定 |
| `hwcliPath` | 包内 `bin/hwcli_lj_co8.exe` | 也可用环境变量 `LJ_CO8_HWCLI_PATH` |

## 现场验收（需要 LCR 表，由用户执行）

`self_test` 不能证明电容值。断开被测设备（RIU）后：

1. 在 testStand 里添加本设备，运行 `self_test`，3 项全部通过。
2. LCR 表（测试频率 1 kHz 或 10 kHz，先做开路清零，表笔线尽量短）接 C0：引脚 20 和 3。
3. 依次 `set_capacitance` 设 5、10、100、500、1000 pF，读表。读数与设定值相差应在 ±0.5 pF 加表的误差和引线分布电容以内。
4. 对每一路至少抽测 100 pF 和 1000 pF（引脚见上表），并在设 C0 为 1000 pF 时测 C1 仍为原值，排查串线。
5. `safe_state` 后抽测通道回到 `safePf`。
6. 记录：序列号、通道、设定值、读数、表的型号和测试频率；任何一项不合格都不要接入被测设备。

## 构建与测试

适配器基于 `teststand-device-sdk`（`devices/sdk`）。本地测试不访问硬件：

```powershell
cd devices
.\test.ps1 -Target lj_co8                 # pytest + 模拟器上的合规检查
python native/build_x86.py                # 修改桥接源码后重建 bin/hwcli_lj_co8.exe（需 VS C++ x86 工具集）
```

交付给 testStand 用设备包：`python devices/pack.py lj_co8` 生成 `devices/dist/lj_co8-<版本>.tsdev`；在 testStand 测试台架点“+ → 添加设备…”选这个文件，先以模拟模式添加验证，再编辑为实物做空载验收。
