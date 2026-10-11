# PXI2604 设备插件

包 `teststand_adapter_art_pxi2604`，设备类型 `art_pxi2604`（入口点组 `teststand.devices`），由 testStand 后端作为插件加载。`isolation = "subprocess"`：ART-SWITCH 驱动在独立子进程里加载（它的 `artSwitch_GetChannelName` 在本驱动上会访问违例，插件从不调用），崩溃只结束子进程；后端退出时子进程先 `safe_state`（全部断开）再退出。插件不带驱动：台架上须安装 ART-SWITCH（`artSwitch_64.dll`），板卡在 ART-SWITCH 里的资源名为 `Dev1`。资料：PXI2604 硬件使用说明书 V6.00.02、ART-SWITCH 头文件 `artSwitch.h`。

一个插件实例只管理一个硬件。公共工具（`get_device_info`、`list_hardware`、`get_hardware_info`、`pxi2604_stream_read`）、信封格式、`/device` 声明（身份、说明、引脚、流、能力）和流读取由 SDK 提供，见 `devices/README.md`。插件只报告测量值和状态，不判定通过 / 失败。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- 继电器 k0–k39，单刀双掷：NCn / COMn / NOn。`closed`（驱动位置 11）= 通电，COMn–NOn 接通；`open`（10）= 释放，COMn–NCn 接通（IVI 继电器约定，按下面验收步骤核实）。最大 100 V、1 A、60 W，动作/释放 ≤ 3 ms。
- `set_relay(relay, closed)`、`set_relays(relays, closed)`：读当前位置，只对要变的继电器各调一次 `artSwitch_RelayControl`（一次调用可带多路），`WaitForDebounce`（≤ `debounceMs`）后读回 40 路位置，与请求不一致即报错并列出 `details.differ`。
- `read_relays`：驱动报告的 40 路位置，证据类型 controller_state，**不是触点测量**。
- `safe_state`、打开、关闭：全部断开（COM–NC）。
- `self_test`（只读，不动作继电器；不调用驱动自带的 `artSwitch_self_test`，它可能动作继电器）：型号 PXI2604、序列号（与配置一致）、继电器数 40、位置等于最后设置、板载动作计数器最大值 < 1e5（手册最低电气寿命，60 VDC 1 A）。

## 流

- `relays`（bits，40 位，bit n = kn，`display: "switches"`，`kind: "measured"`）：打开时和每次切换后发布驱动读回的位置（1 = COM–NO），记录带调用的 `op`。不采样。

## `settings`

| 键 | 默认 | 说明 |
|---|---|---|
| `resourceName` | `Dev1` | ART-SWITCH 资源名 |
| `serialNumber` | 无 | 板卡序列号（本台架 `1019306001`），不一致则拒绝打开 |
| `debounceMs` | `100` | 等待继电器稳定的最长时间，1–10000 ms |
| `dllPath` | ART-SWITCH 安装目录 | 也可用环境变量 `ART_SWITCH_DLL` |

连接器 DIN41612-128 公头，引脚位置按 DIN 41612 列序编号：a1–a32 = 1–32，b1–b32 = 33–64，c1–c32 = 65–96，d1–d32 = 97–128；`/device.pinout` 每个引脚的说明里写着手册上的名字（如 `A32`）。

## 现场验收（需要万用表，由用户执行）

`self_test` 只证明驱动、身份与继电器位置寄存器一致。断开被测设备后，对每一路 kn（引脚见 `/device.pinout`，例如 k0：NC0 = B32，COM0 = C32，NO0 = D32）：

1. 断开状态：COMn–NCn ≈ 0 Ω（< 0.5 Ω，含表笔），COMn–NOn 开路。
2. `set_relay(n, true)`：COMn–NOn < 0.5 Ω，COMn–NCn 开路。这一步同时核实 closed = COM–NO 的约定。
3. `safe_state` 后恢复第 1 步。
4. 记录序列号和每路电阻；任何一路路径电阻 ≥ 1 Ω 或通断与上面相反，不要接入被测设备。

## 构建与测试

适配器基于 `teststand-device-sdk`（`devices/sdk`）。本地测试不访问硬件：

```powershell
cd devices
.\test.ps1 -Target art_pxi2604                 # pytest + 模拟器上的合规检查
```

交付给 testStand 用设备包：`python devices/pack.py art_pxi2604` 生成 `devices/dist/art_pxi2604-<版本>.tsdev`；在 testStand 测试台架点“+ → 添加设备…”选这个文件，先以模拟模式添加验证，再编辑为实物做空载验收。
