# PXI2355L 设备插件

包 `teststand_adapter_art_pxi2355l`，设备类型 `art_pxi2355l`（入口点组 `teststand.devices`），由 testStand 后端作为插件加载。`isolation = "subprocess"`：ART-DAQ 驱动在独立子进程里加载，崩溃只结束子进程；后端退出时子进程先 `safe_state`（全部 DO 关断）再退出。插件不带驱动：台架上须安装 ART-DAQ（本机 1.10，`Art_DAQ_64.dll` 在 System32），设备在 ART-DAQ 里显示为 `Dev2`。资料：PCI/PXI 235xL 硬件使用说明书 V6.00.02、ART-DAQ 头文件 `Art_DAQ.h`。

一个插件实例只管理一个硬件。公共工具（`get_device_info`、`list_hardware`、`get_hardware_info`、`pxi2355_stream_read`）、信封格式、`/device` 声明（身份、说明、引脚、流、能力）和流读取由 SDK 提供，见 `devices/README.md`。插件只报告测量值和状态，不判定通过 / 失败。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- **DI 0–31**（P0.0–P3.7，bit i = P(i/8).(i%8)）：双向光耦，每端口一个公共端 Px.COM，接 −30…+30 V；|V| ≥ 5 V 读 1，≤ 2 V 读 0。`read_di` 一次读 32 路，证据类型 measurement。
- **DO 0–31**（P4.0–P7.7，bit i = P(4+i/8).(i%8)）：ULN2803 达林顿 source 输出，**必须外接 Px.VCC（5–40 V）才有驱动能力**；单路 ≤ 500 mA，整口全开时每路 ≤ 100 mA。`write_do(line, on)` 改一路（其余不变），`write_do_mask(mask)` 一次写 32 路；写后用 DO 任务读回驱动持有的状态（重新建任务也能读到，故不是任务内缓存），不一致即报错。读回不是负载电流或 Px.VCC 的测量。
- `safe_state`：写 `safeMask`（默认 0，全部关断）并读回。打开时也先写 `safeMask`。
- `self_test`（只读，不改变输出）：ART-DAQ 产品型号 PXI2355L、序列号（与配置一致）、DI 可读、DO 读回等于最后写入、DO 上电状态全部为 Low。

## 流

- `di`（bits，32 位，bit i = P(i/8).(i%8)，`kind: "measured"`）：50 Hz 采样，变化时发布。
- `do`（bits，32 位，bit i = P(4+i/8).(i%8)，`kind: "measured"`）：打开时和每次写入后发布读回值，记录带调用的 `op`。

## `settings`

| 键 | 默认 | 说明 |
|---|---|---|
| `serialNumber` | 无 | 板卡序列号（本台架 1015182004）；设了就在 ART-DAQ 的设备里找这张卡 |
| `deviceName` | 自动 | ART-DAQ 设备名（如 `Dev2`），只查这一个 |
| `safeMask` | `0` | `safe_state` 和打开时写入的 DO 掩码 |
| `dllPath` | `Art_DAQ_64.dll` | 也可用环境变量 `ART_DAQ_DLL` |

## 现场验收（需要一台 5–24 V 直流电源和几根线，由用户执行）

`self_test` 只证明驱动、身份和输出寄存器一致。断开被测设备后做 DO→DI 回环：

1. 电源正极接 P4.VCC（引脚 35），负极接 P4.GND（34）；P0.COM（9）也接 P4.GND。
2. P4.0–P4.7（26–33）分别接 P0.0–P0.7（1–8）。
3. `write_do_mask(0)`，`read_di().mask & 0xFF` 应为 0；依次 `write_do(i, true)`（i = 0…7），每次 `read_di` 只有 bit i 为 1；`write_do_mask(0xFF)` 后低 8 位全为 1。
4. `safe_state` 后 DI 低 8 位回到 0。
5. 其余端口同法：P5 (76–83, VCC 85–87, GND 84) → P1 (51–58, COM 59–62)；P6 (38–45, VCC 47–49, GND 46) → P2 (13–20, COM 21–24)；P7 (88–95, VCC 97–99, GND 96) → P3 (63–70, COM 71–74)，DO 第 8k+i 路对应 DI 第 8k+i 路。
6. 记录序列号、电源电压、每一步的掩码；不合格不要接入被测设备。

## 构建与测试

适配器基于 `teststand-device-sdk`（`devices/sdk`）。本地测试不访问硬件：

```powershell
cd devices
.\test.ps1 -Target art_pxi2355l                 # pytest + 模拟器上的合规检查
```

交付给 testStand 用设备包：`python devices/pack.py art_pxi2355l` 生成 `devices/dist/art_pxi2355l-<版本>.tsdev`；在 testStand 测试台架点“+ → 添加设备…”选这个文件，先以模拟模式添加验证，再编辑为实物做空载验收。
