# 插件契约

后端、测试引擎、AI 网关和桌面端都只依赖这份契约。SDK 已经实现了除设备工具以外的全部内容；适配器保证设备工具和设备声明真实。契约版本 `contractRevision` 为 `2026-10-01.1`，出现在 `get_server_info`、`capabilityDetails`、`/device` 和每个设备工具的 `_meta.hardwareharness` 里。

## 加载与进程

| 项 | 要求 |
|---|---|
| 类型发现 | 适配器包在 `pyproject.toml` 声明入口点 `[project.entry-points."hardwareharness.devices"] <type> = "hh_adapter_<adapter>:DEVICE"`。后端用 `device_types()`（`importlib.metadata.entry_points(group="hardwareharness.devices")`）列出可装的类型 |
| 实例配置 | 后端的硬件实例记录 `{transport: "plugin", serverId, label, hardwareId, type, settings, mode: real\|sim, enabled}`。同型号多块卡 = 多个实例，`settings` 区分卡号 |
| 加载 | 后端调用 `open_device(type, ServerConfig)`，再 `start()`：SDK 构造 `DeviceHost`，打开设备并立即 `safe_state` |
| 隔离 | `Device.isolation`：`inproc`（默认，`InprocDevice`，在后端进程内直接调用）或 `subprocess`（`SubprocessDevice`，在 `python -m hardwareharness_device_sdk.child` 子进程里运行，父子之间 stdio JSON 行）。两者对上层是同一个异步句柄，上层看不出区别 |
| 子进程 | 子进程的原 stdout 只给协议用，文件描述符 1 在导入适配器前指向 stderr，驱动打印不会污染协议；stdin EOF（后端退出或关闭）时执行 `safe_state`、关闭设备并退出；Windows 上用 Job Object 保证子进程随后端退出。子进程退出时未完成的调用失败为 `device_unreachable`，`details.outcomeKnown: false` |
| 一实例一硬件 | `list_hardware` 恰好一项，`hardwareId` 等于实例记录的登记值 |
| 模拟 | 实例 `mode: sim`（`ServerConfig.dry_run`，或环境变量 `HARDWARE_DRY_RUN=1`）：`select_driver` 选模拟器，`/device.identity.dryRun` 为 `true`，`executionMode` 报告 `nonphysical_driver_override` |
| 合规检查 | `python -m hardwareharness_device_sdk --adapter <type 或模块> --check`：在模拟器上进程内运行合规套件，见 `sdk-api.md` |
| 时钟 | SDK `now_ms()` 是记录 `t`、水位、`timing` 的唯一时钟，后端的时间也取自它；同一台电脑上不需要对时 |

没有网络端口、令牌和部署：插件就是后端环境里装的一个 Python 包。

## 句柄（后端视角）

`open_device()` 返回的句柄：`start()`、`stop()`（`safe_state` 后关闭）、`describe()`（`{tools, device, hardware}`：工具列表、`/device` 文档、硬件快照）、`call(name, arguments, operation_id)`（返回信封）、`read_stream(streamId, cursor, limit, epoch)`、`seek(streamId, since)`、`watch` / `unwatch(streamId)`、`read_blob(streamId, ref)`、`safe_all()`。适配器不直接接触它，测试里用 `serve()`（见 `sdk-api.md`）。

## 公共工具（SDK 提供）

| 工具 | 类型 | 说明 |
|---|---|---|
| `get_server_info` | read | 版本、就绪状态、`capabilities`（含 `streamTransport`）、`sdkVersion`、`adapter`、`sourceRevision` |
| `list_hardware` | read | 唯一硬件及其生命周期状态 |
| `get_hardware_info(hardwareId)` | read | 状态 + `capabilityDetails`（SDK 通用字段 + 适配器 `capability_details()`） |
| `<prefix>_stream_read` | read | 见 `streams.md` |
| `<prefix>_transact` | actuate | 仅当有带写入器的字节流 |
| `<prefix>_blob_read` | read | 仅当有 `BlobStream` |
| `hardwareharness_prepare_shutdown` | internal | 仅供平台使用：`safe_state` 并拒绝新操作；不给 AI 或测试步骤 |

`get_pinout` 和 `list_streams` 已删除：引脚和流声明一次性从 `/device` 读取。表中的类型是 `/device.tools[].kind`。

工具以 MCP `tools/list` 条目的形状描述（`name`、`description`、`inputSchema`、`outputSchema`、`annotations`、`_meta.hardwareharness`），所以后端可以把它们原样转给 Agent 网关，网关对外的名称是 `<serverId>__<tool>`，并从参数表中去掉 `hardwareId`、由网关注入。

## 操作号 `operationId`

调用方（测试引擎、手动调用、网关）随每次调用传一个 `operationId`（`DeviceHost.call(..., operation_id=)`；子进程协议里是 `params.operationId`）。SDK 把它放进上下文，该调用期间写入的流记录都带 `op`，并在结果 `meta` 中原样返回；省略时 SDK 生成 `srv-*`。适配器不读它，全部由 SDK 处理。

## `/device` 设备声明

`DeviceHost.manifest()` 生成，`describe()` 里的 `device` 就是它：

```json
{"manifestRevision": "sha256:<hex>", "contractRevision": "2026-10-01.1",
 "identity": {"serverId": "...", "hardwareId": "...", "manufacturer": "ADLINK", "model": "PCI-6208V",
              "hardwareRevision": "...", "adapter": {"name": "hh_adapter_pci6208v", "version": "0.2.0"},
              "sdkVersion": "0.2.0", "dryRun": false},
 "description": "Device.description 的一段文字",
 "pinout": {"...": "Pinout 模型", "connectors": [{"connectorId": "...", "name": "CN1", "pinIds": ["..."]}]},
 "streams": [{"id": "ao0", "type": "scalar", "unit": "V", "label": "AO0", "kind": "setpoint"}],
 "capabilities": {"...": "capabilityDetails"},
 "tools": [{"name": "pci6208v_set_voltage", "kind": "actuate"}, {"name": "hardwareharness_prepare_shutdown", "kind": "internal"}]}
```

- 声明只读软件状态，从不访问驱动；设备不可达时也能生成。
- `identity.hardwareRevision` 来自 `Device.hardware_revision`，未设置时省略；`dryRun` 表示实际使用了模拟驱动。
- `pinout` 是适配器 `pinout()` 的结果（`not_supported` 时为 `null`），`None` 字段省略。
- `streams` 是每个流的 `describe()`，见 `streams.md`。
- `tools[].kind` 为 `read` / `configure` / `actuate` / `safe` / `internal`。
- `manifestRevision` 是规范化 JSON 声明的 sha256。它变了（声明变了，或 `capability_details()` 的生效设置、模拟模式变了），后端更新缓存的声明。

## 设备工具（适配器提供）

- 命名 `<prefix>_<name>`，例如 `pci6208v_set_voltage`。第一个参数 `hardwareId` 由 SDK 自动加上。
- 每个工具的 `_meta.hardwareharness` 含 `kind: "hardware"`、`contractRevision`、`operationSemantics`；`kind="safe"` 的工具另有 `safeAction: true`。后端退出时按 `operationSemantics.kind == "safe"` 找到它并调用。
- 注解：`read` → `readOnlyHint=true, idempotentHint=true`；其他 → `destructiveHint=true`。
- 描述不少于 80 个字符，说明它证明什么、不证明什么、失败后怎么办。
- 工具只报告测量值和状态，不判定通过 / 失败：不接收期望值或阈值，不返回 `pass` / `fail`。判定属于测试步骤。

## 操作语义 `operationSemantics`

由 `@tool` 的参数生成，后端编排校验和执行引擎都依赖它：

| 字段 | 来源 | 含义 |
|---|---|---|
| `kind` | `kind=` | `read` / `configure` / `actuate` / `safe` |
| `retry` | 由 kind 推出 | `actuate` 为 `never_after_dispatch`，其余 `safe` |
| `stateRequirements` | `requires=` | 调用前必须成立的状态，例如 `analog_input_configured` |
| `stateEffects` | `effects=` | 调用成功后成立的状态，例如 `serial_port_configured`、`voltage_output_active` |
| `evidenceType` | `evidence=` | 默认 read 为 `controller_state`，其他为 `observation`；真实采样写 `measurement` |
| `safetyAction` | `safety_action=` | 调用后需要登记的恢复动作 `{toolName, arguments}`；短名自动加前缀，必须是已存在的工具 |
| `outcomeOnInvalidResponse` | 固定 | `unknown`：响应无效时视为结果未知，进入人工核销 |

状态名用小写蛇形，一个 `effects` 应该被某个 `requires` 用到，否则就不必声明。

## 结果信封

```json
{"ok": true,  "message": "", "data": {...},
 "meta": {"timestamp": "2026-09-24T08:00:00+00:00", "operationId": "op-17",
          "timing": {"start": 1790000000123.4, "end": 1790000000125.1},
          "streamRefs": [{"streamId": "ao1", "fromSeq": 88, "toSeq": 88}]}}
{"ok": false, "error": {"category": "device_error", "message": "...", "retryable": false,
                        "details": {...}, "recovery": "..."}, "meta": {"timestamp": "...", "operationId": "op-18", ...}}
```

设备工具和 `transact` 的 `meta`：`operationId`；`timing` 为驱动调用的执行区间（`now_ms()`，Unix 毫秒）；`streamRefs` 列出本次调用写入的流记录区间（失败的调用也有）。测试引擎把这些连同完整参数和结果记为调用记录，锚点时刻取 `timing.end`。

`data` 的结构由 `@tool(output=...)` 的模型决定，并出现在 `outputSchema` 里。适配器方法直接返回 `data` 的字典，SDK 负责包信封；抛 `DeviceError` 得到失败信封。参数不合法时 `call()` 直接返回 `invalid_argument` 信封，驱动不会被调用。

## 错误类别

| 常量 | 值 | 何时用 | `retryable` |
|---|---|---|---|
| `INVALID_ARGUMENT` | `invalid_argument` | 参数越界、组合非法；驱动未被调用 | 否 |
| `NOT_CONFIGURED` | `not_configured` | 前置配置缺失，如未 `configure_ai` 就读 | 否 |
| `DEVICE_ERROR` | `device_error` | 驱动返回错误码（默认类别） | 否 |
| `DEVICE_UNREACHABLE` | `device_unreachable` | 打开失败、设备未打开、CLI 不存在或退出、隔离子进程退出 | 是 |
| `SERVICE_UNAVAILABLE` | `service_unavailable` | 设备正在停止（`prepare_shutdown` 之后） | 是 |
| `INVALID_RESPONSE` | `invalid_response` | 驱动或 CLI 的返回无法解析 | 否 |
| `NOT_SUPPORTED` | `not_supported` | 该型号不提供此能力（如没有写入器的流不能发送）、未知工具 | 否 |
| `INTERNAL` | `internal` | 未预期的异常；SDK 会记录日志 | 否 |

`retryable` 只是传输层建议，永远不授权重放物理动作。写操作失败时 `details` 要带上 `requested`、已生效部分和最后已知状态。

## 生命周期

硬件状态：`initializing → open`；打开失败为 `unreachable`，SDK 按 5 s、10 s、30 s 退避重开，重开成功先 `safe_state` 再进入 `open`；停止时 `closing → closed`，关闭失败为 `faulted`。只有 `open` 时设备工具可用，否则返回 `device_unreachable`；采样流此时状态为 `unavailable`。

`safe_state` 的时机：打开后（含重开）、关闭前、`hardwareharness_prepare_shutdown`、隔离子进程的 stdin EOF；后端正常退出时对每个已打开的设备调用 `safe` 工具（单个 5 s 超时），测试运行中止时也调用。后端崩溃时输出可能停在最后值，下一次启动打开后的 `safe_state` 把它拉回。
