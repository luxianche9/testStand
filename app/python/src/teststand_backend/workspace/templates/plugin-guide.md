# testStand 设备插件开发指南（内置 AI 用）

把一台测试资源（板卡、仪器、串口设备……）做成 testStand 设备插件，在**当前项目文件夹**里完成，只用 testStand 的公开工具和本组参考资料。不需要、也不允许查看 testStand 的安装目录或源代码；不能联网，也不能安装第三方 Python 包。

配套参考（`read_reference` 按 ID 阅读或用 `query` 搜索）：

| ID | 内容 |
|---|---|
| `ts-plugin-sdk-api` | SDK API：`Device`、`@tool`、`param`、`model`、配置、模拟器、测试工具 |
| `ts-plugin-streams` | 流（信号）：类型、元数据、采样、写后发布、串口字节流、`control` |
| `ts-plugin-vendor-bindings` | 厂商驱动绑定：ctypes 调 DLL、COM 口、桥接程序、stdout 与子进程隔离 |
| `ts-plugin-contract` | 插件契约：`/device` 声明、公共工具、信封、错误类别、生命周期 |
| `ts-plugin-checklist` | 交付前逐项核对 |

SDK 的函数签名和说明用 `devkit_describe_sdk` 查（不带参数列出全部公开名称；带名称如 `Device`、`param`、`ByteStream`、`multi_connector_pinout`、`testing.serve` 给出签名、文档和成员）。不要猜签名，也不要去磁盘上找 SDK 源码。

参考资料里提到的 `pci6208v`、`cp118u_i`、`pci1710l`、`pci1762` 是 testStand 开发时的示例适配器，不在本机，看不到它们的代码；`devkit_create_adapter` 生成的模板本身就是一个完整、能通过检查的例子。

## 流程

1. **读资料**。用户给的资料目录里找这台设备的手册、头文件（`.h`）、示例代码和 DLL。
   - `.h`、`.cpp`、`.txt`、`.inf` 等文本直接用 read 读。
   - **PDF、Word（.docx）、Excel（.xlsx）和图片一律先 `import_document`**（给出绝对路径）：它把文档转成项目 `docs/` 下的文本并登记为参考，然后用 `read_reference(referenceId, query=...)` 搜索或直接读 `docs/<名>.md`。不要用 read 直接读 PDF 或图片。旧格式 `.doc`、`.xls` 读不了，请用户另存。
   - 手册里画成图的内容（连接器针脚图、扫描页）由离线 OCR 读出，放在该页的“Text read from the picture (OCR …)”小节里，一行对应图里的一行，例如针脚图读成 `DIO0 68 34 DIO1`（左边信号、两列针号、右边信号）。OCR 会认错字（`IO` 认成 `℃` 或 `10`，`I` 认成 `l`/`1`，`VIN` 认成 `VlN`），要和手册正文的信号表、编号规律对照后再用；拿不准的针脚问用户，不要猜。页面图像在 `docs/<名>/page-NNN.png`，可以请用户核对。
   - 整理：型号与厂商原文、通道数与编号起点、每个操作的参数（类型、范围、单位）、返回值、上电和安全状态、错误码、连接器引脚表；驱动是否往 stdout 打印、是否可能崩溃（决定 `isolation`）。
   - 设备在系统里的样子可以用只读命令确认（例如 `list_ports()` 列 COM 口、`Get-PnpDevice`），不要写任何东西到硬件。
2. **建适配器**：`devkit_create_adapter(adapter, model, manufacturer, prefix?)`。`adapter` 是设备类型，小写，例如 `rsx8`、`jcxd_sd48`。生成 `plugins/<adapter>/`：

   ```
   plugins/<adapter>/
     pyproject.toml                 版本、入口点、[tool.teststand.package]
     README.md
     src/teststand_adapter_<adapter>/
       __init__.py                  DEVICE = <类>
       adapter.py                   Device 子类：工具、流、描述
       driver.py                    厂商调用的类型化封装（ctypes）
       sim.py                       与 driver 同接口的模拟器
       pinout.py                    连接器表
     tests/test_<adapter>_adapter.py
   ```

   模板是一张假想的 8 路数字 I/O 卡，用来示范写法；把它改成真实设备的操作。
3. **厂商文件**。厂商 DLL（或桥接 exe）用 `devkit_add_vendor_file(adapter, sourcePath)` 复制进包的 `bin/`，它同时登记到 `requiredFiles`，设备包会带上它。`driver.py` 里按 `Path(__file__).resolve().parent / "bin" / "<名>.dll"` 加载，`settings.dllPath` 可覆盖。只复制 64 位 DLL（testStand 是 64 位进程）。
4. **写 `driver.py`、`sim.py`、`adapter.py`、`pinout.py`**（见下面的要点和 `ts-plugin-sdk-api`、`ts-plugin-vendor-bindings`、`ts-plugin-streams`）。
5. **检查**：`devkit_check_adapter(adapter)`。它在独立进程里用模拟器跑适配器自己的测试（pytest）和 SDK 合规检查，扫描遗留的 `TODO(new_device)`，返回失败的测试与回溯、声明出的工具和流、完整日志。改到 `ok: true` 为止。测试要随设备改写：模板测试检查的是模板的工具名。
6. **打包**：`devkit_package_adapter(adapter)` 先检查，通过后写出 `dist/<adapter>-<版本>.tsdev`。
7. **添加到台架**：`devices_addDeviceFromFile(path)`，path 用上一步返回的绝对路径。操作员在 testStand 里确认清单（设备、厂商驱动、SHA-256）后，设备出现在设备列表里。
   **更新已在台架上的插件**（改了代码、补了针脚）：先**提高 `pyproject.toml` 和 `Device.version` 的版本号**再打包，然后用 `devices_updatePackageFromFile(path)`，**不要**再用 `devices_addDeviceFromFile`（那会为同一块硬件多加一台设备，两台会抢同一个硬件）。新驱动在 testStand 重启后生效：告诉用户点设备列表上方的“重启”，重启后用 `get_hardware_definition` 确认新版本已加载。
8. **上架验证**：`list_devices` 看设备是否在线；`list_device_tools(hardwareId)`、`enable_device_tools(hardwareId)` 展开它的工具，先调只读工具（读状态、读输入）。会改变输出的动作只在用户同意后做，结束时调 `safe_state`。驱动调用成功不等于电气结果正确，最终确认由人完成。

## 写法要点

- **一实例一硬件**：一个插件实例对应一张卡 / 一台仪器。同型号多张卡加多个实例，靠 `settings`（卡号、COM 口、DLL 路径）区分。`settings` 只放非秘密配置。
- **驱动只封装**：`driver.py` 返回原始返回码和数据，不判断、不重试。`adapter.py` 检查返回码，失败抛 `DeviceError(message, category=...)`：找不到 DLL / 端口打不开 → `DEVICE_UNREACHABLE`（SDK 会定时重开），参数越界 → `INVALID_ARGUMENT`。
- **懒加载**：构造驱动对象不加载 DLL、不打开硬件；在 `open()` 里打开。模块 import 绝不能因为缺 DLL 而失败，模拟器和测试要能在没有硬件的电脑上跑。
- **模拟器**：`sim.py` 与 driver 同接口，忠实模拟控制器状态（影子寄存器），输入读成空闲值。`select_driver(real, simulated)` 在检查时自动选模拟器。
- **工具**：每个操作一个 `@tool`，声明 `kind`（`read` 只读、`configure` 改设置、`actuate` 驱动外部信号、`safe` 安全状态）、`evidence`、`effects`；每个参数用 `param(type, "含单位和范围的说明", ge=, le=)`，越界在调驱动前拒绝。
- **安全状态**：必须有一个 `kind="safe"` 的工具（一般叫 `safe_state`），幂等，把所有输出置为手册规定的安全值；SDK 在打开后、关闭前自动调用。
- **流就是信号**：运行中要看到的量声明为流（`ts-plugin-streams`）：输入用采样流，输出写后发布回读或设定值，串口用字节流（后台读线程每次读返回调 `stream.idle()`）。流只读：它们显示在运行监控里（示波器画采样流，终端显示收发记录），也是测试步骤判定的数据来源。控制只走 `kind="actuate"` 的工具：操作员用设备的动作弹窗，测试步骤直接调用工具。
- **端口（引脚）**：`pinout.py` 按手册连接器表写针脚：`function(signal, direction, electrical_type, channel_kind=, channel_index=, mode=)` 描述一个针脚的作用；一个连接器用 `single_connector_pinout(hardware_id, 厂商, 型号, 针数, {针号: (function(...),)}, 出处)`，多个连接器（每口一个 DB9、前后面板）用 `multi_connector_pinout(hardware_id, 厂商, 型号, [(名称, 类型, 针数, {针号: ...}), ...], 出处)`。没写的针号按 NC 发布。不知道的针脚不要编，`pinout()` 返回 `None`（不支持）或问用户。针脚用于接线（`request_wiring`）；流和工具不与针脚关联。
- **隔离**：模板默认 `isolation = "subprocess"`：插件在独立子进程里运行，ctypes 调错（签名、缓冲区长度、未公开的函数）只会让这台设备掉线，SDK 会重开它，不会拖垮 testStand。只有纯 Python / 标准库的驱动（例如用 `SerialPort` 的 COM 口设备）才改成 `"inproc"`。
- **stdout 不能用**：适配器和驱动不许 `print`，用 `logging`（子进程里 stdout 也被重定向到 stderr，但打印仍会被当成协议噪声）。
- **插件不判定**：只报告测量值和状态，不做通过/失败判断；判定写在测试步骤里。
- **不得自动重发**写操作；超时或失败后先读回再决定。
- **只用标准库和 SDK**：`ctypes`、`ctypes.wintypes`、`winreg`、`socket`、`struct`、`threading`、`time`、`json`……没有 numpy、pyserial、pyvisa。

## COM 口设备

驱动在 Windows 里建了 COM 口的设备（多串口卡、USB 转串口、RS-485 模块、仪器的 RS-232 口）直接用 SDK 的 `SerialPort`，不用厂商 DLL：

```python
from teststand_device_sdk import SerialPort, SimulatedSerialPort, list_ports

port = SerialPort("COM3")  # 模拟器：SimulatedSerialPort("COM3", loopback=False)
port.open(baudrate=115200, bytesize=8, parity="N", stopbits=1)  # 打不开 → DEVICE_UNREACHABLE
port.write(b"*IDN?\n")  # 返回写出的字节数
data = port.read(4096)  # 不阻塞：返回已到达的字节，可能是 b""
port.in_waiting()
port.flush(rx=True, tx=True)
port.configure(9600, 8, "E", 1)
port.close()
list_ports()  # [{"port": "COM3", "device": "\\Device\\..."}]
```

一个 COM 口一个实例（`settings.port`），或一个实例管理一张卡的全部口（`settings.ports`），按手册和用户的用法定。字节流的读线程配方见 `ts-plugin-streams` 的字节流一节。

## 在真实硬件上调试

模拟器只能证明代码符合你自己的理解；数据格式、字节序、位域、通道顺序、换算系数只有真实硬件说了算。插件第一次在台架上读出“对不上”的数据时：

1. **先取证，后改代码**。保留原始值（寄存器字、原始码、字节），只用只读工具或只读配置再采几次：每次只配一个通道、换不同通道、看原始字怎么变。让插件的错误 `details` 带上原始值（如 `raw`），正是为了这一步。
2. **数值核对推理**。位域、移位、掩码、补码的结论要算出来再写，例如在 bash 里 `python -c "w=0x0801FFFE; print((w>>24)&0x3F, (w>>22)&0x3F)"`；推出的结果要能解释**所有**采到的原始值，而不只是一次。
3. **不要按猜测改模拟器**。模拟器跟着真实硬件的证据改；只为让测试通过而改模拟器，会让检查通过而真实运行再次失败。
4. 证据不够时，把原始数据和你的几种解释告诉用户，请用户确认（比如接一个已知电压）。

## 遇到问题

- `devkit_check_adapter` 失败：看 `problems`、`tests.failed[].error`（回溯）、`compliance.failures`、`output`；改代码再检查。
- 资料缺关键事实（量程、安全值、针脚）：在代码里留 `TODO(new_device)` 并问用户，检查会因此不通过，这是有意的。
- `devices_addDeviceFromFile` 被拒绝：操作员没有确认，问用户原因。
- 设备 `offline` / `unreachable`：DLL 没找到、卡没装驱动、端口被别的程序占用；看 `refresh_device` 返回的消息。
