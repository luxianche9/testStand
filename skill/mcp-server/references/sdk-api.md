# SDK API（`hardwareharness_device_sdk` 0.2）

全部从包根导入：`from hardwareharness_device_sdk import Device, tool, param, model, ...`。适配器包 `hh_adapter_<adapter>` 的 `__init__.py` 导出 `DEVICE = <类>`，`pyproject.toml` 用入口点把它登记为一个设备类型，后端由此找到设备类。

## 适配器目录

```
mcp_servers/adapters/<adapter>/
  pyproject.toml              依赖 hardwareharness-device-sdk>=0.2,<0.3；入口点 hardwareharness.devices
  README.md                   设备语义、流、settings、构建与测试
  src/hh_adapter_<adapter>/
    __init__.py               DEVICE = <类>
    adapter.py                Device 子类：工具、流、声明
    driver.py                 厂商调用的类型化封装
    sim.py                    与驱动同接口的模拟器
    pinout.py                 连接器表（来自手册）
    py.typed
  tests/test_<adapter>_adapter.py
```

## 入口点

```toml
[project.entry-points."hardwareharness.devices"]
pci1234 = "hh_adapter_pci1234:DEVICE"
```

- 入口点名就是设备类型（实例记录里的 `type`），用适配器 id，小写、唯一。
- `device_types()` 返回 `{类型: "module:attr"}`；`load_device(spec)` 先按入口点名查找，找不到再把 `spec` 当作模块（取 `DEVICE`）或 `module:ClassName`。所以 `--check` 既能写 `--adapter pci1234`，也能写 `--adapter hh_adapter_pci1234`。
- 入口点元数据在安装时生成：改了 `pyproject.toml` 的入口点要重新 `uv sync`（`mcp_servers/` 下）或 `pnpm python:setup`（`HardwareHarness/` 下）。

## `Device`

```python
class Pci1234(Device):
    manufacturer = "Acme"          # 厂商原文
    model = "PCI-1234"             # 型号原文
    prefix = "pci1234"             # 工具前缀：pci1234_set_output
    capabilities = ("digital_output",)
    version = "0.1.0"              # 适配器版本
    instructions = "给 AI 的两三句说明：设备做什么、先调哪个工具、每个输出的物理效果。"
    description = "给人和 AI 的一段设备描述：接口、通道、连接器、限制。出现在 /device.description。"
    hardware_revision = None       # 已知的硬件版本；None 时 /device 省略
    isolation = "inproc"           # 或 "subprocess"：驱动写 stdout、可能崩溃、必须独占进程时

    def __init__(self, config: ServerConfig) -> None:
        super().__init__(config)                 # 必须先调用：建立 self.streams 和 self.io_lock
        self.driver = self.select_driver(lambda: VendorDriver(config.settings.get("dllPath")), SimulatedDriver)
```

| 成员 | 说明 |
|---|---|
| `config: ServerConfig` | 见下文 |
| `hardware_id`、`dry_run` | 来自配置；`dry_run` 即实例的 `mode: sim` |
| `streams: StreamRegistry` | `self.streams.add(stream)` 返回该流，重复 id 报错；`self.streams.scan(streams, fn, rate_hz=)` 建扫描组。见 `streams.md` |
| `io_lock: threading.RLock` | SDK 采样线程持有它调用 `sample()`；适配器自己的后台线程（串口读线程）和字节流写入器访问驱动时也必须持有。工具调用之间已由 SDK 的操作锁串行 |
| `select_driver(real, simulated)` | 模拟模式时构造模拟器，否则构造真实驱动；两者都是无参可调用对象 |
| `tool_name(name)` | `f"{prefix}_{name}"` |
| `open()` | 阻塞：打开设备、取句柄、清影子。失败抛 `DeviceError(category=DEVICE_UNREACHABLE)`，SDK 会重试 |
| `close()` | 阻塞：释放句柄、停止后台线程 |
| `safe_state()` | 默认什么都不做；有输出的设备必须用 `@tool(kind="safe")` 覆盖 |
| `capability_details()` | 非秘密的限值和生效设置；**不能访问驱动**，设备不可达时也要能返回 |
| `pinout()` | 默认抛 `NOT_SUPPORTED` |
| `description`、`hardware_revision` | 类属性，进入 `/device` |
| `isolation` | 类属性，`inproc`（默认）或 `subprocess`，由插件决定，后端和上层无感 |

所有生命周期方法和工具都在工作线程里运行，写普通阻塞代码即可；也可以写成 `async def`。

### 选 `isolation`

| 情况 | 选择 |
|---|---|
| 驱动是 ctypes DLL，安静、稳定 | `inproc` |
| 驱动本身已是独立的 hwcli 子进程（`JsonLineCli`） | `inproc`（隔离已经由 hwcli 提供） |
| DLL 加载或调用时往 stdout 打印（例：PCIS-DASK） | `subprocess` |
| DLL 可能崩溃、泄漏或要求独占进程 | `subprocess` |

`subprocess` 的代价是每次调用、每次读流多一次进程间 stdio 往返，以及一个常驻进程；适配器代码不用改。子进程继承后端的 stderr，日志与后端日志合在一起。

## `@tool`

```python
@tool(kind="actuate", output=Voltage, safety_action="safe_state", effects=("voltage_output_active",),
      description="Set one AO channel ... Never re-send after a timeout: read the ao<n> stream first.")
def set_voltage(self, channel: AoChannel, volts: Volts) -> dict[str, Any]:
    ...
    return {"channel": channel, "volts": volts}
```

| 参数 | 说明 |
|---|---|
| `kind` | `read`（无副作用）、`configure`（改设置，不直接驱动外部信号）、`actuate`（驱动外部信号）、`safe`（恢复安全状态） |
| `description` | 必填，≥ 80 字符，英文，写证据含义和失败后的处置 |
| `output` | `model(...)` 生成的数据模型；省略时为 `dict[str, Any]`（不推荐） |
| `name` | 默认方法名 |
| `requires` / `effects` | 状态前置 / 效果，字符串元组 |
| `evidence` | `controller_state`、`measurement`、`observation` 等 |
| `safety_action` | 短名或 `{"toolName": ..., "arguments": {...}}`；必须指向已存在的工具，否则构造 `DeviceHost` 时失败 |

方法参数不能用 `*args/**kwargs`，每个参数必须用 `param()` 标注。返回值是信封的 `data`。同一份声明同时生成设备页的手动调用表单、Agent 网关的工具和测试计划的步骤目录，不在别处再写一遍。

工具只报告测量值和状态，不接收期望值、不返回通过 / 失败。工具运行期间写入的流记录自动带本次操作号，并进入结果 `meta.streamRefs`；适配器什么都不用做。

## `param` 与 `model`

```python
AoChannel = param(int, "Zero-based AO channel 0..7.", ge=0, le=7)
Volts = param(float, "Output in volts, -10.0..10.0 V (bipolar range).", ge=-10.0, le=10.0, allow_inf_nan=False)
Parity = param(Literal["N", "E", "O"], "Parity: N none, E even, O odd.")
Note = param(str | None, "Optional operator note, at most 200 characters.", max_length=200)

Voltage = model("VoltageResult",
                channel=(int, "Zero-based AO channel."),
                volts=(float, "Value accepted by the driver in V; not a measurement."),
                warning=(str, "Driver warning text.", None))    # 第三项为默认值；None 表示可空可省略
```

`param(type, description, **constraints)` 的约束就是 pydantic `Field` 的参数（`ge/le/gt/lt/min_length/max_length/pattern/allow_inf_nan`），会进入 `inputSchema`。描述里写单位和范围，约束和描述保持一致。

`model(name, field=(type, description[, default]))` 生成输出模型；带 `ContractModel` 的"未设置字段不输出"行为。

> mypy strict 会对 `param()` 别名报 `valid-type`，所有现有适配器都有，属于 SDK 的已知限制，可忽略。

## 错误

```python
raise DeviceError(f"AO_VWriteChannel failed rc={rc}", category=DEVICE_ERROR,
                  details={"rc": rc, "requested": volts, "last_accepted": self.last[channel]})
```

类别常量见 `contract.md`。越界检查在调用驱动之前做（schema 已经拒绝，但直接调用方法的代码路径也要挡住）。

## `ServerConfig`

后端按实例记录构造（`ServerConfig.from_mapping({serverId, hardwareId, manufacturer, model, dryRun, settings})`），测试里用 `dry_run_config(cls, **overrides)`：

| 字段 | 说明 |
|---|---|
| `server_id`、`hardware_id` | 实例身份，来自实例记录 |
| `manufacturer`、`model` | 必须与设备类的类属性一致，否则 `DeviceHost` 拒绝启动；后端从设备类取 |
| `dry_run` | 实例 `mode: sim`，或环境变量 `HARDWARE_DRY_RUN` |
| `settings` | 适配器专用、非秘密：`cardIndex`、`dllPath`、`hwcliPath`、`safeVolts`、采样率等 |
| `build` | 可选的构建信息（源码版本），由 `get_server_info` 报告 |

读 `settings` 时给出默认值，并在 `capability_details()` 里报告生效值。可以兼容历史环境变量（如 `ADLINK_SAFE_VOLTS`），但新设置优先放 `settings`。设备页编辑实例时直接编辑 `settings`，所以键名要在 README 里写清。

## 软件波形（`waveform`）

没有 FIFO 或硬件时钟的静态输出（如 AO 卡）用 `SoftwareWaveform` 出低频波形：

```python
self.waveform = SoftwareWaveform(self._waveform_write, lock=self.io_lock,
                                 streams={ch: self.ao[ch] for ch in CHANNELS},   # kind="setpoint" 的 scalar 流
                                 limits=(-10.0, 10.0), max_update_hz=200.0, max_frequency_hz=20.0)
```

- `write(channel, value)` 是一次阻塞的驱动写，由生成线程持 `lock` 调用；每个写出的值发布到对应的流。相位按 `now_ms()` 相对 `startAt` 计算，不累积漂移，迟到的点跳过。
- `set(channel, shape, frequency_hz, amplitude, offset, *, duty_cycle=, phase_deg=, start_at=)` 启动或替换，返回生效参数；`shape` 为 `SHAPES`（`sine` / `square` / `triangle` / `sawtooth` / `dc`），`amplitude` 是相对 `offset` 的峰值，超出 `limits` 或 `max_frequency_hz` 报 `INVALID_ARGUMENT`。
- `stop(channel, hold_value=None)` 停止并保持静态值；静态写工具先 `cancel(channel)` 取消该通道的波形；`stop_all()` 必须在 `safe_state` 最前面调用；`running()` 报告正在运行的通道；`close()` 在设备的 `close()` 里调用。
- `capability_details()` 里合入 `waveform_capability(channels, mode="software", max_update_hz=...)`，得到 `{"waveform": {channels, mode, shapes, maxUpdateHz, maxSampleRateHz, maxArbitrarySamples, timingAccuracy}}`。软件波形的 `maxUpdateHz` 不超过 `MAX_SOFTWARE_UPDATE_HZ`（200）。
- 工具命名 `set_waveform` / `stop_waveform`，`kind="actuate"`、`safety_action="safe_state"`；完整示例见 `pci6208v`。

## 模拟器（`sim.py`）

- 与驱动同名同签名，返回同样的返回码约定。
- 忠实模拟控制器状态：输出影子、配置门槛（未配置就读要返回相同错误）、句柄。
- 输入默认读空闲值。演示效果只能由环境变量开启：`HARDWARE_DRY_RUN_AI_NOISE`（`sim.ai_noise_enabled()`、`demo_voltage()`）、`HARDWARE_DRY_RUN_SERIAL_LOOPBACK`（`sim.serial_loopback_enabled()`）。
- 记录写入历史（如 `writes` 列表），测试用它证明越界值没有到达驱动。
- 模拟器同时用于：适配器单元测试、`--check`、设备页 `mode: sim` 的实例、桌面应用的端到端测试。它不在设备之间回送接线（没有虚拟台架）。

## 测试工具（`hardwareharness_device_sdk.testing`）

全部在进程内运行，不开端口、不起子进程（`isolation` 不影响测试）：

| 函数 / 成员 | 说明 |
|---|---|
| `check_device(cls, config=None, warnings=[])` | 运行合规套件，返回失败列表；`[]` 表示通过。传入列表收集非致命警告（缺描述、字节流不调 `idle()`）；交付时应为空 |
| `serve(cls, config=None)` | 上下文管理器：在后台线程的事件循环上启动 `DeviceHost`（默认模拟模式），返回 `Harness`；离开时 `safe_state` 并关闭 |
| `hh.call("set_output", channel=1, level=True)` | 按短名调用（自动加前缀、绑定 `hardwareId`），返回信封 |
| `hh.call("set_output", operation_id="op-1", channel=1, level=True)` | 带操作号调用 |
| `hh.call_raw(full_name, arguments)` | 原样调用（不加前缀、不加 `hardwareId`），用于越界等失败路径 |
| `hh.tools` | 工具名 → 工具定义（`tools/list` 条目） |
| `hh.device()` | `/device` 声明文档 |
| `hh.host`、`hh.host.device` | `DeviceHost` 与设备实例（可以直接改模拟器状态）；`hh.hardware_id` |
| `hh.subscribe(stream_id, cursor=None, since=None, epoch=None)` | 上下文管理器：观看一条流并按事件读取；`cursor` 省略为只要新记录，负数为最后若干条；`events.receive()` 返回 `{"type": 事件名, **data}`（`hello` / `batch` / `gap` / `status`）；`events.epoch`、`events.next` 用于续读 |
| `receive_until(events, predicate)` | 读事件直到谓词成立 |
| `dry_run_config(cls, **overrides)` | 构造模拟模式的 `ServerConfig`，可直接构造设备做单元测试 |

命令行等价物：`uv run python -m hardwareharness_device_sdk --adapter <adapter> --check`，输出一行 JSON `{adapter, ok, failures, warnings}`；有失败时退出码 1，警告不影响退出码。它只用模拟器，从不访问硬件。

`--check` 检查：工具元数据（描述长度、注解、`operationSemantics`、`actuate` 不可重试、参数描述）、`list_hardware` 恰好一项且 `open`、`/device` 的形状、修订号与身份、`safe` 工具连续两次成功、`operationId` 回传与 `streamRefs`、每条流的记录格式、`seq`/`t` 递增与水位推进、事件流的 `idle()`、有界数值参数越界被拒绝。
