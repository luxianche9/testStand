# JCXD-DA-CPCI-6401 设备插件

包 `teststand_adapter_jcxd_da6401`，设备类型 `jcxd_da6401`（入口点组 `teststand.devices`），由 testStand 后端作为插件加载。`isolation = "subprocess"`：厂商 `DA6401_JC.dll` 通过内核驱动直接访问板卡，崩溃时只结束子进程，不拖垮后端；后端退出时子进程先 `safe_state` 再退出。x64 DLL 随包在 `bin/`，台架上须已安装厂商内核驱动 `DA6401_JC`（设备管理器里能看到板卡）。资料：JCXD-DA-X-6401 用户手册（硬件 V1.0、软件 V1.0）。

一个插件实例只管理一个硬件。公共工具（`get_device_info`、`list_hardware`、`get_hardware_info`、`da6401_stream_read`）、信封格式、`/device` 声明（身份、说明、引脚、流、能力）和流读取由 SDK 提供，见 `devices/README.md`。插件只报告测量值和状态，不判定通过 / 失败。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- AO 为 0 基通道 0–63，单端模式，引脚见 `/device.pinout`（手册图 3-4，CON1 SCSI-100）。差分模式未实现。
- `write_voltage(channel, volts)` / `set_all(volts)`：接受有限的 ±`outputRangeV` V（标准型 ±10 V），越界直接拒绝，不截断。-3S/-1S/-5S 型号（±15/±30/±40 V）设 `outputRangeV`，插件按手册把写入值除以 1.5/3/4。单路负载 ≤20 mA，整卡 ≤100 mA。
- 本卡没有输出回读。工具结果和 `read_last` 都是驱动接受的设定值（软件影子），不是测量值；本会话没写过的通道 `read_last` 失败。
- `safe_state` 把 64 路都写成 `safeVolts`（默认 0 V），失败通道在 `error.details.failed`。打开时板卡复位（手册：复位后输出 0 V）并创建 64 路单端通道。
- `self_test`（只读）：读板卡信息返回码、板卡类型 0x4204、板卡报告的通道数 64、序列号（配置了 `serialNumber` 时须一致）、64 路通道创建是否成功。通过只说明插件和板卡对上了，不证明输出电压正确，那要按下面的验收步骤测。

## 流

- `ao0`–`ao63`（scalar，`unit: "V"`，`label: "AO<n>"`，`kind: "setpoint"`）：每次成功写入（含 `set_all`、`safe_state`）在写路径上发布设定值，记录带调用的 `op`；不访问硬件，没有采样率。

## `settings`

| 键 | 默认 | 说明 |
|---|---|---|
| `serialNumber` | 无 | 板卡序列号（本台架 637801473）。设了就在 id 0–7 里找这张卡，多卡时用它 |
| `cardIndex` | `0` | 未设 `serialNumber` 时打开的板卡 id |
| `outputRangeV` | `10` | 型号量程：10（标准）、15（-3S）、30（-1S）、40（-5S） |
| `safeVolts` | `0` | `safe_state` 写入的值，须在量程内 |
| `dllPath` | 包内 `bin/DA6401_JC.dll` | 也可用环境变量 `DA6401_JC_DLL` 指定 |

## 现场验收（需要接线，由用户执行）

`self_test` 不能证明输出电压，需要一块电压表或 AI 卡（本台架可用 UMAD-X-3210 的 AI）。断开被测设备（RIU）后：

1. 在 testStand 里添加本设备，运行 `self_test`，5 项全部通过。
2. 抽测通道：至少 AO0、AO31、AO63（分别在 CON1 引脚 50、80、59），每路的回线接旁边的 AGND（例如引脚 47）。
3. 对每一路依次 `write_voltage` 写 -9、-5、0、5、9 V，用表或 AI 读数。标准型精度 0.05 %FSR（20 V 量程约 ±10 mV），加上表的误差，读数与设定值相差应在 ±20 mV 以内。
4. 写 5 V 时测相邻通道（例如 AO1、AO2）仍为 0 V，排查串线。
5. `safe_state` 后所有抽测通道回到 `safeVolts`。
6. 记录：序列号、通道、设定值、读数、表的型号；任何一项不合格都不要接入被测设备。

## 构建与测试

适配器基于 `teststand-device-sdk`（`devices/sdk`）。本地测试不访问硬件：

```powershell
cd devices
.\test.ps1 -Target jcxd_da6401                 # pytest + 模拟器上的合规检查
```

交付给 testStand 用设备包：`python devices/pack.py jcxd_da6401` 生成 `devices/dist/jcxd_da6401-<版本>.tsdev`；在 testStand 测试台架点“+ → 添加设备…”选这个文件，先以模拟模式添加验证，再编辑为实物做空载验收。
