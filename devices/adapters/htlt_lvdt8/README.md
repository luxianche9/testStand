# PXI68802W-I 设备插件

包 `teststand_adapter_htlt_lvdt8`，设备类型 `htlt_lvdt8`（入口点组 `teststand.devices`），由 testStand 后端作为插件加载。`isolation = "subprocess"`：HTLT SDK 在独立子进程里加载，崩溃只结束子进程；后端退出时子进程先 `safe_state`（全部通道禁止输出、关内部激磁）再退出。x64 DLL（`htlt_api_x64.dll`，SDK 2.1）随包在 `bin/`，台架上须已安装 HTLT 2.x 板卡驱动（设备管理器 “L_R_VDT → PCI/PXI-68802W-I LVDT仿真卡”）。资料：8通道LVDT仿真卡使用手册 V2.2、SDK 头文件 `htlt_lvdt_api.h`；输出规律在本机板卡（SN 25021215）上用内部激磁实测确认。

一个插件实例只管理一个硬件。公共工具（`get_device_info`、`list_hardware`、`get_hardware_info`、`lvdt_stream_read`）、信封格式、`/device` 声明（身份、说明、引脚、流、能力）和流读取由 SDK 提供，见 `devices/README.md`。插件只报告测量值和状态，不判定通过 / 失败。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- 通道 0–7。每通道：激磁输入 EXC_n（≤ 10 Vrms、≤ 20 kHz，来自被测设备，或板内 2–7 Vrms / 100–20000 Hz 源），输出 VA_n、VB_n（0–10 Vrms）。只用开环模式；板卡的“跟随”模式没有实现。
- **4-wire**（3/4 线，默认）：`set_position(n, p)`，p ∈ [−1, 1]，VA = Vexc·tr·(1+p)/2、VB = Vexc·tr·(1−p)/2，读数方按 (Va−Vb)/(Va+Vb) 得到 p。**2-wire**：A = `position`、B = `position_b`，VA = Vexc·tr·|A|、VB = Vexc·tr·|B|，符号表示相位。tr 为传输比 0–10（`configure_channel` 或设置 `transmissionRatio`）。
- `configure_channel(n, wiring, excitation, ratio, internal_vrms, internal_hz)`：复位该通道并按新模式配置，**输出保持禁止**，直到 `set_position`。
- `set_position` 写位置并使能输出，返回板卡实测的激磁（Vrms、Hz）和板卡报告的 VA/VB。`disable_channel` 禁止一路输出。`read_channel` 只读。
- 驱动规定：**禁止输出的通道不能读激磁也不能读输出**（`HTLT_CHANNEL_NOT_ENABLE`），这时 `excVrms`/`vaVrms`/`vbVrms` 为 null。
- VA/VB 是板卡报告值，实测与公式吻合到毫伏级，很可能是板卡按实测激磁计算的，**不当作外部测量**；激磁读数是板卡 AD 实测。
- `safe_state`：8 路全部禁止输出并关闭内部激磁。打开时 8 路按设置复位为外部激磁、禁止输出。
- `self_test`（只读，不改变输出）：序列号可读并与配置一致（附硬件/SDK/驱动版本）、已使能通道的激磁与输出可读、已使能通道报告的 VA/VB 与“实测激磁 × 设定”相差 ≤ 2 %。

## 流

- `pos0`–`pos7`（scalar，`kind: "setpoint"`）：`set_position` 写路径发布的位置 p（2-wire 为 A）。
- `exc0`–`exc7`（scalar，`unit: "Vrms"`，`kind: "measured"`，2 Hz 采样）：板卡实测激磁有效值；通道禁止输出时为 `not_configured`。

## `settings`

| 键 | 默认 | 说明 |
|---|---|---|
| `serialNumber` | 无 | 板卡序列号（本台架 25021215），设了就用 `HTLT_OpenBySerialNumber` |
| `boardId` | `1` | 未设序列号时的板卡编号（从 1 起，按 PCI 枚举顺序） |
| `wiring` | `4-wire` | 打开时各通道的接线模式：`4-wire`（3/4 线）或 `2-wire` |
| `transmissionRatio` | `1.0` | 打开时各通道的传输比 tr，0–10 |
| `dllPath` | 包内 `bin/htlt_api_x64.dll` | 也可用环境变量 `HTLT_API_DLL` |

连接器为 DB-62（单板 R1.1，手册表 2-2）：EXC_n_P/N = 1+2n/2+2n，VA_n_P/N = 22+2n/23+2n，VB_n_P/N = 43+2n/44+2n；本台架接线表的 EXC_0_P 在 1 脚、VA_0_P 在 22 脚，与 R1.1 一致。SCSI-68 版（R1.0）的引脚不同，本插件未描述。

## 现场验收（需要交流电压表，或用 MADS-3210 的 AI，由用户执行）

`self_test` 只证明板卡内部一致，输出要实测。断开被测设备后，对每个要用的通道 n：

1. `configure_channel(n, "4-wire", "internal", 1.0, 5.0, 2000)`，`set_position(n, 0.5)`。返回的 `excVrms` ≈ 5.00、`excHz` ≈ 2000。
2. 交流电压表量 VA_n_P–VA_n_N ≈ 3.75 Vrms，VB_n_P–VB_n_N ≈ 1.25 Vrms（±0.2 %FS，即 ±0.02 V，加表的误差）。也可以把 VA_n_P 接 MADS 的一路 VIN、VA_n_N 接 AGND，MADS `aiRateHz` ≥ 20000，`read_ai([k], 200)` 的 std 即有效值。
3. `set_position(n, -1.0)`：VA ≈ 0、VB ≈ 5.00 Vrms；`set_position(n, 0)`：两路都 ≈ 2.50 Vrms。
4. 外部激磁：被测设备或信号源接 EXC_n，`configure_channel(n)`（默认外部）后 `set_position(n, 0)`，`excVrms`/`excHz` 应与信号源一致，VA、VB 各为其一半。
5. `safe_state` 后各路输出为 0。记录序列号和读数；不合格不要接入被测设备。

## 构建与测试

适配器基于 `teststand-device-sdk`（`devices/sdk`）。本地测试不访问硬件：

```powershell
cd devices
.\test.ps1 -Target htlt_lvdt8                 # pytest + 模拟器上的合规检查
```

交付给 testStand 用设备包：`python devices/pack.py htlt_lvdt8` 生成 `devices/dist/htlt_lvdt8-<版本>.tsdev`；在 testStand 测试台架点“+ → 添加设备…”选这个文件，先以模拟模式添加验证，再编辑为实物做空载验收。
