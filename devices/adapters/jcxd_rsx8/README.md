# JCXD-RS-CPCI-8MI 设备插件

包 `teststand_adapter_jcxd_rsx8`，设备类型 `jcxd_rsx8`（入口点组 `teststand.devices`），由 testStand 后端作为插件加载。`isolation = "subprocess"`：读线程和串口句柄在独立子进程里，崩溃只结束子进程；后端退出时子进程先 `safe_state`（丢弃待发数据）再退出。台架上须安装厂商的 RSX8_JC **虚拟串口驱动**（DriverSetup → ports；设备管理器“多串口适配器 → RSX8-JC-8MI”和 8 个“RSX8_JC Port (COMn)”）。厂商的 `RSX8_JC.dll` 只在另一种（JC）驱动下可用，本机装的是虚拟串口驱动，插件因此走 Windows 串口 API（SDK `SerialPort`），不带 DLL。资料：JCXD-RS-X 用户手册 硬件 V1.0（§3.3.2 异步 8MI 引脚）、软件 V1.0（§1 虚拟串口属性、附录 C 通道对应）。

一个插件实例只管理一个硬件。公共工具（`get_device_info`、`list_hardware`、`get_hardware_info`、`rsx8_stream_read`）、信封格式、`/device` 声明（身份、说明、引脚、流、能力）和流读取由 SDK 提供，见 `devices/README.md`。插件只报告测量值和状态，不判定通过 / 失败。超时或错误不表示物理动作没有发生：保留原错误，查询当前状态并取证后再决定下一步。

## 设备语义

- 物理通道 0–7，每路一个 COM 口。通道与 COM 口的对应和每路的电气模式从驱动注册表读取（`Enum\PCIUART\OEMPORT\*&Port<n>\Device Parameters` 的 `PortName`、`RsMode`、`LoopBack`；`RsMode` 1 = RS-232、2 = RS-422、3 = RS-485）。**模式只能在设备管理器 → 端口属性 → Port Settings → Vendor Tools 里改**，插件只读。本机 8 路目前都是 RS-485、自环关。
- `configure_port(channel, baudrate, bytesize, parity, stopbits)`：打开并配置，RS-232 最高 115200，RS-422/485 最高 2000000（手册），不发送数据，在流上留 configure 标记。
- `write_text` / `write_hex`：发送；返回驱动接受的字节数，不代表对方收到。`clear_rx=true` 先丢弃已收数据。`rsx8_transact`（SDK 提供）：发送并等待匹配的回复。
- `read_rx`：返回上次清除以来收到的字节（不消耗），证据类型 measurement；`clear_rx` 清除。`port_info`：COM 口、模式、自环、当前串口参数。
- `safe_state`：丢弃所有已配置通道的待发数据，不发送任何字节，端口保持打开。
- `self_test`（只读，不发送）：8 个 COM 口存在、模式已知（设置 `expectedModes` 时核对是否符合接线要求）、自环关闭、未被占用的端口能打开。

## 流

- `serial0`–`serial7`（bytes，可写）：收到的数据（`rx`，读线程每 10 ms 轮询，每次读空后 `idle()`）、发送的数据（`tx`，经 `stream.send`）、`configure`/`clear_rx` 标记，记录带调用的 `op`。未配置的通道每次轮询都确认空闲。

## `settings`

| 键 | 默认 | 说明 |
|---|---|---|
| `portMap` | 从注册表读 | 8 个 COM 口，通道 0–7 依次，如 `COM3,COM4,...,COM10`；注册表找不到时必填 |
| `expectedModes` | 无 | 接线要求的 8 路模式，如 `RS422,RS422,RS422,RS422,RS485,RS485,RS232,RS232`，自检据此核对驱动设置 |
| `rxBufferBytes` | `1048576` | 每路流保留的字节数 |

通道与 COM 口的对应以注册表 `Port<n>` 为准；厂商工具 `DriverSetup\ports\JCUartTool.exe` 也能显示“物理通道 ↔ COM 口 ↔ 工作模式 ↔ 自环”，两者应一致。

## 现场验收（需要短接线，由用户执行）

`self_test` 只证明端口和驱动设置可用。断开被测设备后，两两对接做收发：

1. **RS-422**（两路都设为 RS-422）：通道 a 的 OUTa+/OUTa− 接通道 b 的 INb+/INb−，反向也接；两路 GD 相连。例如通道 0（OUT0− 33、OUT0+ 34、IN0+ 67、IN0− 68）与通道 1（OUT1− 17、OUT1+ 18、IN1+ 51、IN1− 52）。
2. **RS-485**（两路都设为 RS-485）：OUTa+ 接 OUTb+，OUTa− 接 OUTb−，GD 相连。
3. **RS-232**：OUTa− 接 INb+，OUTb− 接 INa+，GD 相连。
4. 两路 `configure_port` 同样参数（如 115200 8N1），`write_hex(a, "55 aa 00 ff", clear_rx=true)`，`read_rx(b)` 应收到同样 4 字节；反向再做一次；再在最高波特率（RS-422/485 为 2000000）下重复。
5. 每一对都做过后记录序列号、模式、波特率和结果；有丢字节或乱码的不要接入被测设备。

## 构建与测试

适配器基于 `teststand-device-sdk`（`devices/sdk`）。本地测试不访问硬件：

```powershell
cd devices
.\test.ps1 -Target jcxd_rsx8                 # pytest + 模拟器上的合规检查
```

交付给 testStand 用设备包：`python devices/pack.py jcxd_rsx8` 生成 `devices/dist/jcxd_rsx8-<版本>.tsdev`；在 testStand 测试台架点“+ → 添加设备…”选这个文件，先以模拟模式添加验证，再编辑为实物做空载验收。
