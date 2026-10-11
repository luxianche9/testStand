# JCXD-MADS-CPCI-3210 设备插件

包 `teststand_adapter_jcxd_mads3210`，设备类型 `jcxd_mads3210`（入口点组 `teststand.devices`），由 testStand 后端作为插件加载。`isolation = "subprocess"`：厂商 `UMADX3210_x64.dll` 通过内核驱动直接访问板卡并在后台持续采集，崩溃时只结束子进程；后端退出时子进程先 `safe_state` 再退出。x64 DLL 随包在 `bin/`，台架上须已安装厂商内核驱动 `UMADX3210`（设备管理器“Devices-JC → UMAD-X-3210”）。资料：JCXD-MADS-X-3210/-XS 产品手册、JCXD-MADS-X-3210 用户手册-软件 V1.0.0、厂商例程 demo_1/4/5/09/12。

一个插件实例只管理一个硬件。公共工具（`get_device_info`、`list_hardware`、`get_hardware_info`、`mads_stream_read`）、信封格式、`/device` 声明（身份、说明、引脚、流、能力）和流读取由 SDK 提供，见 `devices/README.md`。插件只报告测量值和状态，不判定通过 / 失败。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- **AI**（0–31 单端，或 0–15 差分：AIn+ = VINn，AIn− = VIN(n+16)）：打开后即按 `aiChannels`/`aiRateHz`/`aiMode` 用板卡硬件时钟连续采集，每 20 ms 从驱动缓冲区取整帧。板卡把采样率分给扫描表：`aiRateHz × 通道数 ≤ 500 000`。驱动按 ±10 V 换算，-1S/-2S 型号乘 3/6，由 `inputRangeV` 决定，**必须与型号一致**。每个采样字带通道号（bit29..24），与扫描表不一致的帧丢弃并计数（自检项“AI 帧对齐”）。
  - `read_ai(channels, duration_ms)`：从调用时刻起等待 `duration_ms` 的新样本，返回每路 mean/min/max/std/n，证据类型 measurement。
  - `configure_ai(channels, rate_hz, mode)`：停止并按新扫描表重启采集。
- **AO**（0–7）：`write_ao` 静态 ±10 V；`start_wave` 用板卡自带波形发生器（正弦/方波/三角/锯齿，1–20 000 Hz，幅值 + |偏移| ≤ 10 V），`stop_wave` 停止并保持给定电压。没有输出回读：结果和 `ao<n>` 流都是设定值。单路 ≤10 mA，总 ≤80 mA。
- **DIO**（0–47，TTL）：打开时全部为输入（板上 JP1–JP6 默认上拉，悬空读 1）；`configure_dio(outputs)` 把列出的线设为输出并立即置 `doSafeLevel`，其余设回输入。`write_do` 写后读寄存器（`IO_GetDOChanStatus`），不一致即报错。`read_dio` 返回输入电平、输出寄存器和方向。
- **CT**（0–1）：`start_frequency`/`read_frequency`（Pulse_In_n 频率）、`start_count`/`read_count`（脉冲计数）、`start_pwm`（PWM_Out_n，0.1 Hz–4 MHz，占空比 0–100 %，运行中再调用即更新）、`stop_counter`。
- `safe_state`：停止所有 PWM 和波形，8 路 AO 写 `safeVolts`（默认 0 V），所有 DIO 输出写 `doSafeLevel`（默认 0）。AI 采集不停。
- `self_test`（只读，不改变任何输出）：板卡信息返回码、板卡类型 0x3210、AI 通道数 32、序列号、AI 1 秒实收采样率在配置值 ±5 % 内、帧对齐无错、所有扫描通道读数未饱和、48 路 DIO 输入可读、DIO 输出寄存器与最后写入一致。

## 流

- `ai0`–`ai31`（block，`unit: "V"`，`kind: "measured"`）：硬件定时样本块 `{t0, dt, samples[]}`，`dt = 1000/aiRateHz` ms，每 50 ms 一块（声明里的 `rateHz: 20` 是块的发布频率，不是采样率）。不在扫描表里的通道为 `not_configured`。没人订阅时最多保留最近 2 s。
- `ao0`–`ao7`（scalar，`kind: "setpoint"`）：`write_ao`/`stop_wave`/`safe_state` 写路径发布的设定值；波形运行期间不发布。
- `di`（bits，48 位，bit i = DIOi，`kind: "measured"`）：50 Hz 采样输入电平，变化时发布；输出线的位为 0。
- `do`（bits，48 位，`kind: "measured"`）：每次写 DO / 改方向后发布寄存器回读值。
- `freq0`、`freq1`（scalar，`unit: "Hz"`）：计数器处于频率测量模式时 5 Hz 采样，否则 `not_configured`。

## `settings`

| 键 | 默认 | 说明 |
|---|---|---|
| `serialNumber` | 无 | 板卡序列号（本台架 621216518）；设了就在 id 0–7 里找这张卡 |
| `cardIndex` | `0` | 未设 `serialNumber` 时打开的板卡 id |
| `inputRangeV` | `10` | 型号输入量程：10（标准）、30（-1S）、60（-2S）。**本台架是 -2S，填 60** |
| `aiChannels` | `"0-31"` | 打开时的扫描表，如 `"6-13"` 或 `[0,1,2]` |
| `aiRateHz` | `1000` | 每通道采样率，Hz |
| `aiMode` | `"single"` | `single` 或 `differential` |
| `doChannels` | 无 | 打开时设为输出的 DIO 线，如 `"0-7"` |
| `safeVolts` | `0` | `safe_state` 写入 AO 的电压 |
| `doSafeLevel` | `0` | `safe_state` 和 `configure_dio` 写入 DIO 输出的电平 |
| `dllPath` | 包内 `bin/UMADX3210_x64.dll` | 也可用环境变量 `UMADX3210_DLL` |

## 现场验收（需要接线，由用户执行）

`self_test` 证明插件和板卡对得上、采集按配置速率在跑，但不证明信号路径。断开被测设备后，用短线做以下回环（引脚见 `/device.pinout`，C0/C1 = Connector 0/1）：

1. **AO→AI**：VOUT0（C1-56）接 VIN0（C1-68），AGND（C1-67）就近。`aiChannels` 含 0。依次 `write_ao(0, v)`，v = -9、-5、0、5、9 V，每次 `read_ai([0], 200)`。标准型（±10 V）mean 与 v 相差 ≤ 20 mV；-2S 型（±60 V）分辨率较粗，≤ 0.1 V。std 应 < 20 mV（-2S < 50 mV）。
2. **波形与采样率**：同上接线，`aiRateHz` 设 10000，`start_wave(0, "sine", 5, 100)`，在示波器视图看 ai0 为 100 Hz、峰值 5 V 的正弦，每周期约 100 点；`read_ai([0], 1000)` 的 max/min ≈ ±5 V。`stop_wave(0)`。
3. **DIO**：DIO0（C0-68）接 DIO1（C0-34）。`configure_dio([0])`，`write_do(0, 0)` 后 `read_dio().inputs` 的 bit1 = 0；`write_do(0, 1)` 后 bit1 = 1。对 DIO24（C1-1）/DIO25（C1-35）重复，覆盖第二个连接器。
4. **计数器**：PWM_Out_1（C1-50）接 Pulse_In_0（C0-19），DGND 相连。`start_pwm(1, 1000, 50)`，`start_frequency(0)`，`read_frequency(0)` ≈ 1000 Hz（±0.1 %）。`safe_state` 后频率读数不再更新。
5. 再跑一次 `self_test`，全部通过。记录序列号、每步的设定值与读数；任何一步不合格都不要接入被测设备。

## 构建与测试

适配器基于 `teststand-device-sdk`（`devices/sdk`）。本地测试不访问硬件：

```powershell
cd devices
.\test.ps1 -Target jcxd_mads3210                 # pytest + 模拟器上的合规检查
```

交付给 testStand 用设备包：`python devices/pack.py jcxd_mads3210` 生成 `devices/dist/jcxd_mads3210-<版本>.tsdev`；在 testStand 测试台架点“+ → 添加设备…”选这个文件，先以模拟模式添加验证，再编辑为实物做空载验收。
