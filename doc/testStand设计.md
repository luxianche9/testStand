# testStand 设计文档

## 0. 文档约定

### 0.1 地位

- **本文件是 testStand 设计的唯一真源。** 代码、技能文档（`skill/device-plugin/`）、README 与本文件冲突时，以本文件为准，并按第 12 章的对齐清单修改代码。
- 旧设计文档《智能化通用测试软件设计文档》《运行可观测性与数据面设计》已废止，其中仍然有效的内容已并入本文。
- 基础概念的解释见 [基础概念与架构教程](基础概念与架构教程.md)。本文只写规定，不写科普。

### 0.2 用词

| 标记 | 含义 |
|---|---|
| **必须 / 禁止** | 硬性规定，违反即为缺陷 |
| **应** | 默认要求，偏离时要在代码注释或提交说明中写明理由 |
| **可** | 允许但不要求 |
| **【目标】** | 本文规定、代码尚未实现的行为；对应第 12 章的对齐项。未加标记的内容都描述已实现的行为 |

### 0.3 变更流程

1. 设计变更先改本文件，再改代码，二者可以在同一次提交中完成。
2. 重大取舍记录在第 11 章，编号为 `DEC-xx`；编号只增不复用。被推翻的决策从表中删除，并在表下注明由哪条决策取代。
3. 插件契约版本 `CONTRACT_REVISION` 的变化必须同步修改第 4 章。

### 0.4 修订记录

| 日期 | 内容 |
|---|---|
| 2026-09-30 | 重写为单一设计文档。新增：设备声明 `/device`；波形输出；被测产品协议层；测试语义补充 |
| 2026-09-30 | 重写第 9 章终端软件架构：后端作为可独立运行的工作站服务；操作注册表同时生成 HTTP、MCP 与 TS 类型；运行日志作为唯一记录；前后端只保留 HTTP + SSE；密钥改用系统凭据库。新增 P9～P10、DEC-13～DEC-18、第 12.6 节 |
| 2026-10-01 | 删除命令行 `hh` 和虚拟台架（原 T8、T9）：没有使用者，维护成本高于收益。DEC-18 改为不做虚拟台架；第 9.8 节只保留测试分层 |
| 2026-10-03 | 单机插件化重构（任务书 `doc/plan/单机插件化重构.md`）：测试资源与测试终端在同一台电脑；每台设备从远程 MCP HTTP 服务改为后端进程内插件，必要时隔离到 stdio 子进程（第 2、4 章）；删除租约、测试资源图片、远程部署与服务管理、时钟同步、设备 SSE 数据通道。删除 DEC-01、DEC-02、DEC-03、DEC-05、DEC-07，新增 DEC-19～DEC-23；第 12 章按完成情况重写 |
| 2026-10-03 | 设备包：发布版不再内置适配器，每种设备类型以 `.tsdev` 设备包安装（第 4.1、4.8 节）；新增 DEC-24 |

---

## 1. 目标与非目标

### 1.1 目标

testStand 是一套通用的智能测试软件。目标是用**一套平台 + 每种设备一个适配器 + 每个产品一份测试计划和 ICD**，替代过去每个项目单独开发一套上位机的做法（见 `doc/research/` 中 A、B、C、D 四个历史项目）。

1. **设备接入标准化。** 每类测试资源被封装为一个设备插件，对外暴露统一的声明、工具和流。适配器应能由 AI 按厂商 SDK 头文件和手册编写，并在模拟器上自测。以后增加新类型的测试资源，只需要新增一个适配器包。
2. **测试逻辑数据化。** 测试计划是结构化数据，由步骤树、参数、表达式和断言组成，可以校验、比较、复用，而不是代码。
3. **判定基于证据。** 每个判定都能追溯到带时间戳的原始数据，能够在事后重新判定。证据不足时明确给出 Inconclusive，而不是猜测。
4. **物理安全优先。** 结果未知的物理动作绝不自动重发；设备打开后、测试运行中止时、软件正常退出时，设备都回到安全状态。后端崩溃时输出可能停在最后值，下次启动打开设备后立即回到安全状态（DEC-21）。
5. **AI 辅助，人负责。** AI 可以编写适配器、ICD 和计划，也可以调试和分析；实物验证和最终放行由人完成。

### 1.2 非目标

| 非目标 | 说明 |
|---|---|
| 跨网络使用测试资源 | 测试资源与测试终端在同一台电脑上（DEC-19）。不支持多台终端共享、交换测试资源，也不做远程部署 |
| 微秒级实时控制 | 端到端时间精度为毫秒级（第 5.8 节）。需要微秒级时序的测量由仪器完成，结果作为数值返回 |
| 闭环反应式仿真 | “收到 A 帧后 50 µs 内回 B 帧”这类逻辑不写在测试计划里，而是写在设备插件的场景工具或板卡固件中（第 5.7 节） |
| 通用 SCADA / 监控平台 | 只服务于测试，不做长期工况监控和报警平台 |
| 替代仪器厂商软件 | 仪器的高级功能（例如示波器的协议触发）通过适配器工具暴露，不在终端重新实现 |

---

## 2. 系统总体架构

### 2.1 组成

一台电脑同时运行测试终端并驱动全部测试资源：

```
┌──────────────────────────── 测试电脑（台架电脑）──────────────────────────────┐
│ Electron 桌面应用（只负责显示：窗口、原生对话框，第 9.6 节）                     │
│   渲染进程（React）：设备 / 台架接线 / 计划 / 运行台 / Agent 面板                 │
│   主进程：启动 Python 后端、窗口、原生对话框、自动更新                           │
│      │ 启动 Python；stdout 一行握手 {port, token}；关闭 stdin = 退出            │
│      │ 渲染进程直连 HTTP /api/ops + SSE /api/events、/api/live（127.0.0.1，单 token）│
│      ▼                                                                        │
│ Python 后端（teststand_backend，单进程，可脱离界面运行，第 9 章）          │
│   接入层  HTTP API │ Agent MCP 网关（127.0.0.1:8000）← 同一个操作注册表生成      │
│   应用层  设备清单 · 计划 · 运行 · 判定 · 报告 · ICD · 执行协调                  │
│   领域层  计划 IR / 编译器 / 解释器 / 判定器 / 表达式 / 协议解码                 │
│   资源层  设备宿主 · 流 hub · 运行存储 · 系统凭据库                              │
│   OpenCode 进程管理 ──► OpenCode Agent（本地 LLM，OpenAI 兼容接口）              │
│      │                                                                        │
│   设备宿主：按实例配置加载 N 个设备插件（teststand_device_sdk + teststand_adapter_x）│
│      ├─ isolation: inproc     → 在后端进程内直接调用（CP-118U-I / PCOMM）        │
│      └─ isolation: subprocess → stdio JSON 行子进程（PCI-6208V / PCIS-DASK）     │
│            （PCI-1710L、PCI-1762 的厂商 SDK 本身经 hwcli_*.exe 子进程调用）       │
│   厂商 DLL / VISA / 串口 → 板卡与仪器 → 接线 → 被测产品（DUT）                    │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 插件模型

> **DEC-19：设备是后端进程内的插件。** 适配器包用 entry point 声明设备类型，后端按实例配置加载；需要隔离时由插件自己声明在 stdio 子进程中运行。设备与后端之间没有网络、令牌、租约和时钟同步。

| 方面 | 规定 | 第几节 |
|---|---|---|
| 驱动定义 | 适配器继承 SDK 的 `Device`，用 `@tool` 声明操作，用类型化的流声明数据 | 4.1、4.4 |
| 类型发现 | 适配器包在 `pyproject.toml` 声明 entry point 组 `teststand.devices`，后端用 `importlib.metadata.entry_points` 列出可用类型 | 4.1 |
| 实例配置 | 后端硬件记录 `{type, settings, mode: real\|sim}`；同型号多块卡 = 多个实例 | 4.7 |
| 宿主 | SDK 的 `DeviceHost` 承载一个设备：工具、信封、操作号、生命周期、流、声明 | 4.2 |
| 隔离 | `Device.isolation = "inproc" \| "subprocess"`，由插件决定，上层无感 | 4.5 |
| 声明 | `/device` 文档由 SDK 从类属性、`pinout()`、`capability_details()`、流注册表和工具表自动生成 | 4.3 |
| 工具 | 每个 `@tool` 的签名与 `operationSemantics` 同时生成界面表单、Agent 工具和测试步骤目录 | 4.4 |
| 流 | 后端直接读插件的环形缓冲（隔离插件经子进程的 stdio），带序号、水位线和缺口 | 5 |
| 时钟 | SDK `now_ms()` 与后端 `backend_ms()` 是同一个时钟源，设备时间就是后端时间 | 5.8 |
| 仿真 | `mode: sim` 时 `select_driver(real, simulated)` 选模拟器；同一接口的另一实现 | 4.6 |
| 合规 | `--check` 在模拟器上进程内跑合规套件 | 4.1 |

同一信息只有一个来源：引脚、流清单只从 `/device` 获得，不再有同义的工具；工具 schema 只从 `@tool` 获得。

### 2.3 分层与“协议层”的位置

工具调用和流是**并列的两条通道**，它们之间没有协议层。所谓“协议层”，是叠加在流**之上**、位于**后端**的一层：

```
            ┌──────────────── 后端 ──────────────────────┐
  判定/显示  │ Observe / Expect / Guard / 运行台曲线与表格   │
            │        ▲ 字段流 dut.status.voltage ...       │
  协议层     │ 被测产品协议层：按 ICD 把字节/报文解成字段      │ ← DUT 专有，换产品只换 ICD
            │        ▲ 原始 bytes / frames 流               │
  流         │ hub：订阅、录制                               │
            └────────▲─────────────────────────────────────┘
                     │ 读环形缓冲
            ┌────────┴──── 设备插件（测试资源专有，与 DUT 无关）┐
            │ serial1: {dir: rx, data: "aa5505..."}          │
            └───────────────────────────────────────────────┘
```

- 设备插件只描述**测试资源**（例如“CP118U 的串口 1 收到了这些字节”），**禁止**内置任何被测产品的协议知识。
- 被测产品协议层（ICD 解码层）属于后端，详见第 6 章。

---

## 3. 设计原则

| 编号 | 原则 |
|---|---|
| P1 | **一台设备一个插件实例。** 插件默认在后端进程内运行；驱动会写 stdout、可能崩溃或必须独占进程时，隔离到子进程 |
| P2 | **原始数据优先。** 插件发布原始测量和原始字节；换算、解码、判定都在后端完成，并保存原始数据以便重新计算 |
| P3 | **判定唯一。** 判定逻辑只存在于后端 `streams/judge`。调试、正式运行、AI 分析都调用同一个判定器 |
| P4 | **时间同源。** 动作锚点、流记录和后端时间使用同一个时钟（SDK `now_ms()`），不需要对时；只有缺少设备计时的锚点才带不确定度（第 5.8 节） |
| P5 | **未知就是未知。** 结果未知的动作进入核销；证据不足判为 Inconclusive；从不把“没收到”当作“没发生” |
| P6 | **收尾即安全。** 设备打开或重开后、关闭前、测试运行中止时、后端正常退出时都执行 `safe_state`。后端崩溃不在保证范围内（DEC-21） |
| P7 | **声明即数据。** 设备能力、引脚、ICD、计划都是可校验的数据文件，不是代码里的常量 |
| P8 | **AI 可写、可测、不可放行。** AI 产出必须通过自动检查和模拟器测试；标记“适配完成”必须有人工实物冒烟记录 |
| P9 | **一处定义，多处生成。** 后端的每个操作只定义一次（参数、返回、权限、风险），HTTP 接口、Agent 工具和前端类型都从这一处生成，不手写第二份 |
| P10 | **日志即记录。** 一次运行的全部事实都以追加方式写进运行日志；报告、重新判定从日志推导，不另存一份可变状态 |

---

## 4. 设备插件

### 4.1 包结构与加载

- SDK：`devices/sdk/src/teststand_device_sdk`，提供 `Device` 基类、`@tool`、信封、操作号、生命周期、流与环形缓冲、`/device` 生成、软件波形、`DeviceHost`、插件加载与子进程隔离、进程内测试工具与合规检查。SDK 不依赖 FastMCP、Starlette、uvicorn。
- 适配器：`devices/adapters/<name>/src/teststand_adapter_<name>/`，包含：

| 文件 | 内容 |
|---|---|
| `adapter.py` | 设备类：工具、流、能力、`isolation` |
| `driver.py` | 调用厂商 SDK 的真实驱动 |
| `sim.py` | 模拟驱动，行为与真实驱动一致 |
| `pinout.py` | 连接器与引脚声明 |
| `__init__.py` | `DEVICE = <设备类>` |

- 类型发现：适配器包的 `pyproject.toml` 声明

  ```toml
  [project.entry-points."teststand.devices"]
  pci6208v = "teststand_adapter_pci6208v:DEVICE"
  ```

  entry point 名就是设备类型。`device_types()` 列出已安装的类型；`load_device(spec)` 先按类型名查找，找不到再把 `spec` 当作模块（取 `DEVICE`）或 `module:Class`。后端操作 `devices.listDeviceTypes` 返回 `[{type, manufacturer, model, isolation, description}]`，导入失败的类型带 `error`，设备页据此提示为什么不能添加。
- 交付：发布版 testStand 只带 SDK，不带任何适配器。每种设备类型以**设备包**（`.tsdev`）交付，在设备管理页“设备类型”里安装（第 4.8 节）。开发环境把四个现有适配器以 editable 方式装在后端的 dev 依赖组里，作为内置类型供后端测试和端到端测试使用；同一类型既内置又装成设备包时，类型列表报“重复声明”，安装也会拒绝。
- `devices.listDeviceTypes` 的每一项另带 `version` 与 `source`（`builtin` 内置 / `package` 设备包）。
- 加载：后端对每个启用的插件实例调用 `open_device(type, config)`，得到一个句柄，再 `start()`（第 4.2 节）。
- 合规检查：`python -m teststand_device_sdk --adapter <type|module> --check` 在模拟器上进程内运行合规套件，输出一行 JSON `{adapter, ok, failures, warnings}`，有失败时退出码为 1。它从不访问硬件。适配器状态从“开发中”到“可用”必须先通过它（第 8.4 节）。

### 4.2 宿主与句柄

`DeviceHost` 承载一个设备，没有任何传输：

- 工具以 MCP `tools/list` 条目的形状描述（`name`、`description`、`inputSchema`、`outputSchema`、`annotations`、`_meta.teststand`），所以同一份描述可以原样交给 Agent 网关。
- `call(name, arguments, operation_id=)` 校验参数，在操作上下文中执行工具，返回第 4.4.4 节的信封；参数不合法时直接返回 `invalid_argument` 信封，驱动不会被调用。
- `manifest()` 生成 `/device` 文档（第 4.3 节）。

`open_device()` 返回的句柄对 `inproc` 和 `subprocess` 是同一个异步接口：

| 方法 | 用途 |
|---|---|
| `start()` / `stop()` | 打开设备并 `safe_state` / `safe_state` 后关闭 |
| `describe()` | `{tools, device, hardware}`：工具列表、`/device` 文档、硬件快照 |
| `call(name, arguments, operation_id)` | 调用一个工具，返回信封 |
| `watch(streamId)` / `unwatch(streamId)` | 观看计数；采样型流只在有人观看时采样 |
| `read_stream(streamId, cursor, limit, epoch)` | 读环形缓冲（第 5.5 节） |
| `seek(streamId, since)` | 某时刻起第一条记录的游标 |
| `read_blob(streamId, ref)` | 读 blob 内容 |
| `safe_all()` | 执行 `safe_state` |

后端 `devices/plugin_transport.py` 的 `PluginTransport` 实现后端的设备传输协议：连接 = 加载并打开，断开 = `safe_state` 并关闭。工具目录项由 `devices/tool_catalog.py` 生成，上层（应用层、测试引擎、Agent 网关）只看到统一的工具目录、结果信封和 `/device`。

### 4.3 设备声明 `/device`

设备声明是**设备页、接线页和 AI 共同的显示和推理依据**。名称沿用历史路径 `/device`，它是 `DeviceHost.manifest()` 生成的文档，不是网络端点。

#### 4.3.1 结构

```jsonc
{
  "manifestRevision": "sha256:9f2c…",        // 对下面全部内容求哈希，任何变化都会改变
  "contractRevision": "2026-10-01.1",
  "identity": {
    "deviceId": "PCI1710L_1",
    "hardwareId": "PCI1710L_CARD_0",
    "manufacturer": "Advantech",
    "model": "PCI-1710L",
    "hardwareRevision": "B1",                 // 可选
    "adapter": {"name": "teststand_adapter_pci1710l", "version": "0.3.0"},
    "sdkVersion": "0.2.0",
    "dryRun": false                           // true 表示正在使用模拟驱动
  },
  "description": "12 位多功能采集卡：16 路单端 AI、16 DI、16 DO …",
  "pinout": {                                 // 与 SDK Pinout 模型一致
    "activeMode": "single_ended",
    "modes": [ … ],
    "connectors": [
      {"connectorId": "CN1", "name": "SCSI-68", "connectorType": "scsi68", "gender": "female",
       "pinIds": ["CN1.1", …]}
    ],
    "pins": [ {"pinId": "CN1.1", "connectorId": "CN1", "position": 1,
               "functions": [{"signal": "AI0", "direction": "input", "electricalType": "analog",
                              "channelKind": "ai", "channelIndex": 0, "mode": "single_ended"}]} ]
  },
  "streams": [
    {"id": "ai0", "type": "scalar", "unit": "V", "rateHz": 20, "label": "AI0", "kind": "measured"},
    {"id": "di",  "type": "bits",   "width": 16, "bitLabels": ["DI0", …], "kind": "measured"},
    {"id": "serial1", "type": "bytes", "writable": true}
  ],
  "capabilities": { … },                      // 即 capabilityDetails，含 waveform 等（第 5.6 节）
  "tools": [ {"name": "pci1710l_read_voltage", "kind": "read"} ]   // 摘要；完整 schema 以工具描述为准
}
```

#### 4.3.2 规则

1. `/device` 的内容由适配器的类属性、`pinout()`、`capability_details()`、流注册表和工具表**自动生成**，适配器作者不手写 JSON。生成只读软件状态，从不访问驱动，设备不可达时也能生成。
2. 缺少 `description` 时 `--check` 给出警告；`pinout()` 抛出 `not_supported` 以外的错误时 `--check` 失败。
3. `manifestRevision` 变化时（适配器升级、生效设置变化、驱动模式切换），后端必须更新缓存的声明，同时使相关计划的 `bindingRevision` 校验重新运行。
4. 引脚数量很大（数百个）时，`/device` 仍返回完整清单，由界面本地分页。
5. 接线只使用结构化的引脚数据（`Pinout` / `Connector` / `Pin`）。测试资源没有外观图和端口图（DEC-22）。

#### 4.3.3 与公共工具的关系

| 工具 | 处理 |
|---|---|
| `get_pinout` / `list_streams` | 已删除，内容在 `/device.pinout`、`/device.streams` |
| `get_device_info` / `get_hardware_info` | 运行态查询：生命周期状态、最近错误、生效能力。静态声明以 `/device` 为准 |
| `list_hardware` | 一个实例一个设备，只返回一项 |

AI 通过网关读取声明（第 8.3 节的 `get_hardware_definition`），而不是直接调用插件。

### 4.4 工具

#### 4.4.1 工具命名与参数

- 设备工具命名为 `<prefix>_<name>`，例如 `pci6208v_set_voltage`。第一个参数是 `hardwareId`，由 SDK 自动加上。
- 后端的工具目录和 Agent 网关对外的名称为 `<deviceId>__<toolName>`，并从参数表中去掉 `hardwareId`，由后端注入。
- 每个工具的描述至少 80 字，必须说明：它证明什么、不证明什么、失败后怎么办。
- 同一份 `@tool` 声明生成设备页手动调用的表单、Agent 工具和测试步骤目录中的工具，不另写第二份。

#### 4.4.2 工具种类 `kind`

| kind | 含义 | MCP 注解 | 失败后能否自动重试 |
|---|---|---|---|
| `read` | 只读，不改变设备 | `readOnlyHint` | 可以 |
| `configure` | 改变设置，但不产生对外的物理作用（例如设置量程、配置串口参数） | `destructiveHint` | 仅当工具声明幂等时可以 |
| `actuate` | 产生物理作用（输出电压、闭合继电器、发送报文、启动波形） | `destructiveHint` | **禁止**（`retry: never_after_dispatch`） |
| `safe` | 回到安全状态 | `destructiveHint` | 可以（幂等） |
| `internal` | 平台内部使用，例如关停准备 `teststand_prepare_shutdown` | — | — |

每个工具附带 `operationSemantics`：`kind`、`retry`、`stateRequirements`、`stateEffects`、`evidenceType`、`safetyAction`，以及 `outcomeOnInvalidResponse: "unknown"`。

#### 4.4.3 调用上下文 `operationId`

调用方随每次调用传一个 `operationId`：插件经 `DeviceHost.call(..., operation_id=)`（隔离子进程的协议里是 `params.operationId`）。

| 字段 | 必填 | 用途 |
|---|---|---|
| `operationId` | `configure`/`actuate` 必填；其余可选 | 全局唯一的动作编号。SDK 把它放进 `ContextVar`，调用期间产生的所有流记录都带 `op` 字段，并在结果中返回，用于证据关联和结果核销。省略时 SDK 生成 `srv-*` |

- `operationId` 不出现在工具的 `inputSchema` 中，AI 看不到也无需填写，由测试引擎、手动调用或网关注入。
- 格式：测试运行中为 `<runId>.<stepPath>.<attempt>`；手动调用为 `manual.<uuid>`。

#### 4.4.4 结果信封

所有工具返回统一信封：

```jsonc
// 成功
{"ok": true, "message": "AO1 已设为 2.500 V",
 "data": {"channel": 1, "voltage": 2.5},
 "meta": {"timestamp": "2026-10-03T08:00:00+00:00", "operationId": "run42.s7.a1",
          "timing": {"start": 1790000000100.2, "end": 1790000000101.9},     // SDK 时钟，Unix 毫秒
          "streamRefs": [{"streamId": "ao1", "fromSeq": 88, "toSeq": 88}]}}
// 失败
{"ok": false, "message": "…",
 "error": {"category": "device_error", "message": "…", "retryable": false,
           "details": {"rc": -1, "requested": 2.5}, "recovery": "…"},
 "meta": { … }}
```

- `timing.end` 是动作的**锚点**：驱动调用返回的时刻，用于第 7 章的时间窗口。
- `streamRefs` 列出这次调用期间写入的流记录范围（失败的调用也有）。
- 错误类别：

| 类别 | 含义 |
|---|---|
| `invalid_argument` | 参数不合法 |
| `not_configured` | 前置配置未完成 |
| `device_error` | 驱动报告错误 |
| `device_unreachable` | 设备无法访问；隔离子进程退出时未完成的调用也是这一类，`details.outcomeKnown: false` |
| `service_unavailable` | 设备正在停止，拒绝新操作 |
| `invalid_response` | 设备返回无法解析的结果；对 `actuate` 而言，这意味着结果**未知** |
| `not_supported` | 不支持的操作 |
| `internal` | 插件内部错误 |

- `retryable` 只是建议，永远不授权重放物理动作。
- 插件以 `CONTRACT_REVISION` 标识契约版本，当前为 `2026-10-01.1`。

### 4.5 隔离子进程

> **DEC-20：需要隔离时用 stdio 子进程，不用回环 HTTP。** 父子进程之间是 JSON 行协议，寿命由父进程管理。

- `Device.isolation = "subprocess"` 时，`open_device()` 返回 `SubprocessDevice`：启动 `python -m teststand_device_sdk.child`（冻结打包后为后端可执行文件加 `--device-child`），父进程持代理。
- 协议：父进程写 `{"id", "method", "params"}` 一行，子进程回 `{"id", "result"}` 或 `{"id", "error": {"message", "category"}}`。方法与第 4.2 节的句柄一一对应（`start`、`describe`、`call`、`read_stream`、`seek`、`watch`、`unwatch`、`read_blob`、`safe_all`、`stop`）。请求在子进程内并发执行，驱动调用仍由 `io_lock` 串行。
- stdout 只给协议用：子进程在导入适配器之前把文件描述符 1 指向 stderr，驱动打印的内容进日志，不会污染协议，也不会污染后端给 Electron 的握手行。
- 寿命：子进程在 stdin EOF（后端退出或关闭管道）时执行 `safe_state`、关闭设备后退出；Windows 上父进程把子进程放进 kill-on-close 的 Job Object，后端进程消失时子进程随之结束。
- 子进程退出时，所有未完成的调用失败为 `device_unreachable`（结果未知）；后端不自动重启它，下一次连接重新加载。
- 选择：PCI-6208V 为 `subprocess`（PCIS-DASK 加载时写 stdout）；CP-118U-I 为 `inproc`；PCI-1710L、PCI-1762 的厂商 SDK 已经经 `hwcli_*.exe` 子进程调用（`JsonLineCli`），适配器为 `inproc`。

### 4.6 设备生命周期与安全

- 状态机：

  ```
  initializing → open → closing → closed
  initializing → unreachable（打开失败）
  closing → faulted（关闭失败）
  ```

  只有 `open` 状态接受 `configure`/`actuate`/`read`；其他状态返回 `device_unreachable`，采样流的状态为 `unavailable`。

- 重开：`unreachable` 时按 5 s、10 s、30 s 退避重开，重开成功后先执行 `safe_state`，再进入 `open`。
- `safe_state` 执行时机：
  - 设备打开（含重开）后；
  - 设备关闭前（`stop()`，包括隔离子进程的 stdin EOF）；
  - 测试运行中止时（运行的 cleanup 阶段）；
  - 后端正常退出时：`DeviceService.safe_all()` 在测试运行收尾之后，并发调用每个已连接设备中 `operationSemantics.kind == "safe"` 的工具，单个 5 s 超时，失败只记日志、不阻塞退出；
  - `safe` 类工具被调用。
- 后端崩溃时不执行任何收尾，输出（例如 6208V 的 AO）可能停在最后值；不做看门狗（DEC-21）。下次启动打开设备后的第一次 `safe_state` 负责把它拉回。
- 适配器必须实现 `safe_state()`，把所有输出置于无害值：AO 为 0 V（或配置的安全值）、DO 为低、继电器断开、波形停止、电源输出关闭。`--check` 在模拟驱动上验证它连续两次都成功。
- 并发：
  - 单设备串行：工具调用经 SDK 的操作锁（`operation_lock`）一次一个；所有驱动调用都在 `io_lock`（RLock）下执行，采样线程和适配器的后台读线程也持有它。
  - 运行与手动互斥：后端 `application/execution.py` 的 `ExecutionCoordinator` 按 `hardwareId` 登记正在进行的活动（一次测试运行占用它用到的全部设备，一次手动调用占用一台设备），冲突时返回 `conflict` 和冲突的活动。它是进程内的互斥，不是租约（DEC-23）。
- 模拟：实例 `mode: sim`（SDK 中为 `dryRun`，也可用环境变量 `HARDWARE_DRY_RUN=1`）时 `select_driver(real, simulated)` 选模拟驱动，`/device.identity.dryRun` 为 `true`，`executionMode` 为 `nonphysical_driver_override`，界面必须醒目标示。模拟器输入读空闲值；演示噪声、串口回环只能用 `HARDWARE_DRY_RUN_*` 环境变量开启。

### 4.7 实例配置与凭据

- 后端硬件实例记录（`devices/device_store.py` 的 `devices` 目录）分两种：

  ```jsonc
  // 设备插件
  {"deviceId": "PCI1762_1", "label": "PCI-1762", "hardwareId": "PCI1762_CARD_0",
   "type": "pci1762",                        // teststand.devices 中的类型名
   "settings": {"cardIndex": 0, "hwcliPath": "…"},   // 适配器自定义、非秘密
   "mode": "real",                           // real | sim
   "enabled": true}
  ```

- 设备页“添加测试资源”从已安装类型中选择 `type`，编辑 `settings` 与 `mode`。同型号多块卡就添加多个实例，用 `settings` 区分卡号。
- 后端按实例构造 SDK 的 `DeviceConfig`：`manufacturer`/`model` 取自设备类，`dryRun = (mode == "sim")`。
- **禁止**把令牌、密码写进 `settings` 或提交到仓库。
- 密钥由后端通过 Python `keyring` 访问系统凭据库（Windows 上是“凭据管理器”），服务名固定为 `testStand`。条目：`gateway`（Agent 网关令牌）、`opencode.llm.api-key`（LLM 密钥）。旧 `safeStorage` 条目不导入。

### 4.8 设备包（.tsdev）

- 格式：ZIP，内含 `package.json`（清单）与 `wheels/*.whl`（适配器 wheel，及其第三方依赖的 wheel）。清单字段：`formatVersion: 1`、`kind: "devicePlugin"`、`type`、`distribution`、`version`、`manufacturer`、`model`、`isolation`、`description`、`sdk`（要求的 SDK 版本范围）、`vendorDrivers`（台架需预装的厂商驱动）、`files`（wheel 名 → SHA-256）、`builtAt`。
- 打包：`python devices/pack.py <adapter>|--all`。先跑适配器测试和 `--check`，确认 `[tool.teststand.package] requiredFiles`（如 DAQNavi 桥接程序 `bin/*.exe`）在 wheel 里，再构建 wheel、下载第三方依赖 wheel，写到 `devices/dist/<类型>-<版本>.tsdev`。
- 安装前检查（`devices.inspectPackage`，不写任何东西）：大小、条目数、路径安全；每个 wheel 的 SHA-256；wheel 标签须为 CPython 3.11 / 64 位 Windows 或纯 Python；只有一个 wheel 声明 `teststand.devices`，且类型名、发行包名与清单一致；SDK 版本满足 `sdk` 与适配器的 `Requires-Dist`；其余依赖在包内或由 testStand 自带且版本满足（testStand 自带的依赖 wheel 安装时跳过）；类型不能是内置类型。有问题时列出原因，安装按钮不可用。
- 信任：设备包里的代码在后端进程（或其隔离子进程）里运行，能调用驱动、读写文件。testStand 不做签名校验；安装前必须向用户显示清单（型号、厂商、版本、运行方式、厂商驱动、文件与 SHA-256），用户确认后才安装。安装、卸载只能由人操作（能力 `devices.manageDevices`），Agent 只能列出。
- 存放：`<用户数据>/plugins/<类型>/<版本>-<SHA-256 前 12 位>/site/`，是解压后的 wheel（包目录 + `*.dist-info`），可直接放到 `sys.path` 上；`plugins/installed.json` 记录每个类型当前的目录、版本与清单信息。
- 加载：后端启动时先处理上次留下的待生效变更，再把每个已装类型的 `site` 追加到 `sys.path`，并设置环境变量 `TESTSTAND_PLUGINS_DIR`；隔离子进程（第 4.5 节）启动时读同一个环境变量做同样的事，所以子进程里 `load_device` 能找到同一个类型。之后 entry point 发现与内置类型完全相同。
- 生效时机：新类型安装后立即可用。已装类型的升级、重装和卸载只记为待生效（`pending`），在下次启动 testStand 时应用，因为已导入的模块不能安全替换；设备页显示“重启后生效”，并提供“重启 testStand”。卸载后，引用该类型的测试资源显示类型不可用。
- 现有四块卡（PCI-1710L、PCI-1762、PCI-6208V、CP-118U-I）与新设备走同一条路：各出一个设备包，随发布版一起提供。

---

## 5. 流

### 5.1 目标

流回答“设备上发生了什么、什么时候发生的”。它必须满足：

1. **完整性可知**：读取方总能知道自己有没有漏数据、漏了哪一段。
2. **时间可信**：每条记录都有 SDK 时钟的时间戳，它就是后端时间。
3. **可续读**：读取方用游标 `epoch` + `seq` 从断点接着读，不重复、不遗漏；设备重开后通过 epoch 变化得知。
4. **可判定“没有发生”**：通过水位线确认某时间段内的数据已经全部到达。
5. **动作可关联**：动作期间产生的记录带有 `operationId`。
6. **按需工作**：没有观看者时，轮询类设备不做采样。

### 5.2 流模型

一台设备有若干条**流**，每条流是一串按 `seq` 递增的**记录**。所有记录都有公共字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `seq` | 整数 | 从 0 开始，每条 +1，单个 epoch 内严格递增、无空洞（被覆盖的部分通过 `gap` 报告） |
| `t` | 浮点 | SDK 时钟，Unix 毫秒（第 5.8 节） |
| `op` | 字符串，可选 | 产生这条记录时正在执行的 `operationId`；后台线程产生的记录没有此字段 |

六种流类型：

| 类型 | 语义 | 记录字段 | 典型来源 | 电平/事件 |
|---|---|---|---|---|
| `scalar` | 一个数值随时间变化 | `v` | AI 通道、电源测量值、AO 设定值 | 电平 |
| `bits` | 一组开关量，一个整数的各位 | `mask` | DI、DO、继电器状态 | 电平 |
| `bytes` | 字节流片段，带方向 | `dir: rx\|tx\|mark`、`data`（十六进制）、`note?` | 串口 | 事件 |
| `frames` | 有身份标识的报文 | `dir`、`id`（整数）、`data`（十六进制）、`note?` | CAN、429、1553B、1394 | 事件 |
| `block` | 一段等间隔采样 | `t0`（= `t`，首点时间）、`dt`（毫秒）、`samples[]` | 高速采集的缓冲区 | 事件（每块独立） |
| `blob` | 大对象引用 | `ref`（内容的 SHA-256） | 示波器截图、波形文件 | 事件 |

流声明（`/device.streams[]`）除 `id`、`type` 外可带以下字段（未设置的省略）：

| 字段 | 适用类型 | 含义 |
|---|---|---|
| `unit` | scalar、block | 物理单位，例如 `V`、`A`、`Hz` |
| `width` | bits | 位数 |
| `bitLabels` | bits | 可选，每位的名称 |
| `rateHz` | 轮询类流 | 生效的采样频率 |
| `writable` | bytes、frames | 是否可以通过 `_transact`/发送工具写入 |
| `idScheme` | frames | 身份编码方案，见第 5.4 节 |
| `label` | 全部 | 显示名 |
| `kind` | 全部 | `measured`（测得值）或 `setpoint`（设定值影子），用于显示和证据分级 |

### 5.3 插件内部结构

```
驱动回调线程 ──publish()/rx()──┐
                               ▼
Sampler（有观看者时按 rateHz 轮询 sample()，在 io_lock 下执行）──► RingBuffer（每条流一个，容量 4096 条）
                               ▲                                 │
工具调用（ContextVar 带 op）───┘                                 ├─► 后端 StreamSource（录制、判定、实时显示）
                                                                 └─► <prefix>_stream_read（Agent / 手动调试）
```

- **环形缓冲**：每条流一个，默认容量 4096 条（bytes/frames 同时有字节上限）。写满后覆盖最旧记录。`publish` 线程安全，可以在厂商回调线程中直接调用。
- **Sampler**：只在观看计数大于 0 时运行（`watch`/`unwatch`），频率 0.1～200 Hz。一个 Sampler 可以同时服务多条流（扫描组，例如 1710L 的 16 路 AI 一次读出，共享 `t`）。
- **操作标记**：工具执行期间，`operation.CURRENT`（ContextVar）指向当前动作。`asyncio.to_thread` 会复制上下文，所以驱动线程中追加的记录也带 `op`；SDK 自己创建的后台线程不带。
- **blob**：内容存在独立的 LRU 中（默认最多 64 个、32 MB），记录里只放 `ref`。内容通过句柄的 `read_blob` 或 `<prefix>_blob_read(ref)` 读取。

### 5.4 frames 的 `id` 编码约定

`frames.id` 是一个整数。各总线必须按下表把身份字段编码进去，并在流声明的 `idScheme` 中注明：

| `idScheme` | 编码 | 说明 |
|---|---|---|
| `can` | CAN ID；扩展帧加 `1 << 31` | 与 SocketCAN 的 EFF 标志一致 |
| `a429` | `sdi << 8 \| label`；`data` 为完整 32 位字（小端 4 字节） | label 取线上的原始 8 位值，显示时转换为八进制 |
| `m1553` | 命令字（`RT << 11 \| TR << 10 \| SA << 5 \| WC`）；`data` 为数据字（每字 2 字节，小端）；状态字放在 `note` 中，或者作为 `dir: "rx"` 的第二条记录 | 模式码按命令字原样编码 |
| `ieee1394` | `channel << 16 \| msgType`（AS5643 消息 ID） | 异步包使用 `1 << 31 \| tcode << 16 \| 源节点` |
| `raw` | 适配器自定义，必须在工具描述中说明 | 最后手段 |

### 5.5 读取协议

#### 5.5.1 读环形缓冲

后端直接读插件的环形缓冲（隔离插件经子进程的 stdio 转发同样的调用）：

| 调用 | 含义 |
|---|---|
| `watch(streamId)` / `unwatch(streamId)` | 观看计数；采样型流只在计数大于 0 时采样 |
| `read_stream(streamId, cursor, limit, epoch)` | 从 `cursor` 起最多 `limit` 条，返回 `{streamType, epoch, records, next, watermark, gap?, status}`。`cursor = None` 只要新记录；负数表示最后若干条 |
| `seek(streamId, since)` | 第一条 `t ≥ since` 的记录的游标。电平型流从“该时刻仍然有效的记录”开始，所以窗口起点的值总是已知 |

- 游标只在同一 `epoch` 内有效。`epoch` 在缓冲建立时随机生成，设备重开后改变；带着旧 `epoch` 读时，从最旧的记录重新开始，并报 `gap{reason: reset}`。
- 请求的记录已被覆盖时报 `gap{reason: overflow, fromSeq, toSeq}`，然后从最旧的仍存在的记录继续。
- 未知的流报错，读取方报告 `unknown_stream`。

#### 5.5.2 事件

后端 `streams/source.py` 的 `StreamSource` 跟随一条流，把读取结果整理为事件：

| 事件 | `data` | 发送时机 |
|---|---|---|
| `hello` | `{streamType, epoch}` | 每次（重新）开始跟随时 |
| `batch` | `{records: [...], watermark}` | 每 50 ms 把新记录打包，每批最多 500 条；记录增加 `tb`（后端时间，等于 `t`） |
| `gap` | `{reason, fromSeq, toSeq, t0, t1}` | 记录被覆盖（overflow）或设备重开（reset）；`(t0, t1)` 是缺数据的时间区间 |
| `status` | `{state, sampling, errors, lastError?, watermark}` | 状态变化时，且至少每 200 ms 一次；推进水位线 |
| `state` | `{state: disconnected \| unknown_stream, message}` | 设备未加载或读取失败（以 0.2～5 s 退避重试）；`unknown_stream` 结束跟随 |

- 流 `status.state` 取值：`idle`、`sampling`、`live`、`not_configured`、`error`、`unavailable`、`closed`。
- `sampling`：轮询类流当前是否在采样。

#### 5.5.3 水位线

> **watermark 承诺：所有 `t ≤ watermark` 的记录都已经在缓冲中（读取方已经读到），或者已经以 `gap` 报告。**

- 对轮询类流，水位线等于最近一次采样尝试的时刻（即使值没有变化、即使采样失败）。
- 对事件类流（bytes、frames），水位线等于读线程最近一次调用 `idle()` 确认“到此为止没有更多数据”的时刻，通常是读线程最近一次读取返回的时刻。适配器必须至少每 200 ms 调用一次，`--check` 检查水位落后时钟不超过约 350 ms。
- 只在工具调用里同步发布的流（写即发布的回读、设定值），水位随时钟推进。
- 驱动出错或停止采样时，水位线**停止推进**。读取方因此等不到水位线，最终判为 Inconclusive（`watermark_timeout`），而不是误判为“没有发生”。
- 适配器如果无法给出这个承诺（例如厂商 SDK 只在有数据时回调），必须定期调用一次空读，或者用 `set_state` 把状态标为 `error`，并在工具描述中说明。

#### 5.5.4 背压与丢失

- 插件不为慢读取方无限缓存。读取方落后超过环形缓冲容量时，被覆盖的部分以 `gap{overflow}` 报告。
- 后端 hub 应及时消费（它只做追加写入，不做计算），正常情况下不会产生 overflow。

### 5.6 波形输出

> **DEC-06：波形由离硬件最近的一方生成。测试计划和后端只下发波形参数或一整段采样点，禁止逐点推送波形。**

原因：操作系统调度和调用链的抖动是毫秒级的，逐点推送的波形会严重变形；而且后端忙或中止时输出会停在某个随机值上。

#### 5.6.1 能力声明

`capabilities.waveform`：

```jsonc
{"waveform": {
   "channels": [0, 1, 2, 3, 4, 5, 6, 7],
   "mode": "software",               // hardware：板卡或仪器按硬件时钟输出；software：插件内的线程定时写入
   "shapes": ["sine", "square", "triangle", "sawtooth", "dc"],
   "maxUpdateHz": 200,               // software 模式的写入频率上限
   "maxSampleRateHz": null,          // hardware 模式的采样率上限
   "maxArbitrarySamples": 4096,
   "timingAccuracy": "±5 ms jitter"  // 给判定使用的时序精度说明
}}
```

SDK 的 `waveform_capability(...)` 生成它；软件波形的 `maxUpdateHz` 不超过 200。

#### 5.6.2 工具

| 工具 | kind | 参数 |
|---|---|---|
| `<prefix>_set_waveform` | actuate | `channel, shape, frequencyHz, amplitude, offset, dutyCycle?, phaseDeg?, startAt?`（SDK 时钟，可选，用于多通道同步起始） |
| `<prefix>_load_arbitrary` | configure | 【目标】`channel, samples[]`（或 `blobRef`）、`sampleRateHz, repeat: true\|count` |
| `<prefix>_start_waveform` | actuate | 【目标】`channel`（用于 `load_arbitrary` 之后） |
| `<prefix>_stop_waveform` | actuate | `channel, holdValue?`（默认回到 `offset`） |

- `set_waveform` 调用成功即开始输出。结果信封的 `data` 返回实际生效的参数（例如频率被量化后的值）。
- 插件同时把**设定值影子**发布到一条 `kind: setpoint` 的 scalar 流：software 模式下发布每个写入值；hardware 模式下只发布参数变化事件。运行台据此显示“应该输出什么”，但判定输出是否正确时，必须使用独立测量（例如 AI 通道）。
- `safe_state` 必须首先停止所有波形。
- software 模式的波形由 SDK 的 `SoftwareWaveform` 在插件内的专门线程中生成，相位按 `now_ms()` 相对 `startAt` 计算，不累积漂移，迟到的点跳过；每次写入仍在 `io_lock` 下执行。

#### 5.6.3 慢速步进与复杂剖面

| 需求 | 做法 |
|---|---|
| 慢速扫描（每点停留 ≥ 100 ms，例如 0～10 V 每 0.5 V 一步） | 计划中使用 `ForEach` + `InvokeTool(set_voltage)` + `Observe`，每一步都有独立的锚点和判定 |
| 较快的分段剖面（例如 50 ms 一段的阶梯、斜坡） | 【目标】`<prefix>_run_profile(channel, segments[{durationMs, from, to, shape}], repeat)`，由插件执行 |
| 高频或精密波形 | 必须使用 hardware 模式的设备：带 FIFO 的 DA 卡、AWG、信号源 |

**现有设备**：PCI-6208V 只有静态 DA，只提供 `mode: software`、`maxUpdateHz ≤ 200`、频率 ≤ 20 Hz 的低频波形。另外，台架上该卡的 ±15 V 供电故障，输出始终约为 0 V（硬件问题，见团队记录）。

### 5.7 流不做什么

- **不做反应式控制。** 后端观察到某条记录后再下发动作，延迟为数十毫秒且不确定。需要“收到 X 立即回 Y”的场景（例如模拟 1553B RT 应答、周期报文调度），必须在设备插件内实现为**场景工具**，例如 `<prefix>_start_rt_simulation(config)`，由插件甚至板卡固件完成。
- **不做 DUT 协议解码**（见第 2.3 节）。
- **不做判定。** SDK 和适配器中不含判定或比较逻辑（`transact` 的 `expect` 只决定何时停止等待）。

### 5.8 时间与时钟

- **唯一的时钟**：SDK `clock.now_ms()` = 进程启动时读取一次的墙钟 + `perf_counter` 流逝量。单调、不倒退，单位为 Unix 毫秒（浮点）。
- 流记录的 `t`、信封的 `timing`、水位线、后端的 `backend_ms()`，全部使用这个时钟。设备与后端之间的偏移和不确定度都是 0（`streams/clock.py` 的 `SharedClock`），不需要对时。
- 隔离子进程在自己启动时锚定墙钟；只有两次锚定之间墙钟被调整，两者才会有差别，忽略不计。
- **锚点的不确定度**：工具结果带 `timing.end` 时，锚点就是它，没有不确定度。结果没有设备计时时，锚点取后端记录的调用结束时刻，不确定度为调用耗时；判定窗口按它收缩（第 7.7 节）。
- **精度边界**：端到端精度受操作系统调度限制，为毫秒级。需要更高时间精度的测量由仪器完成。

### 5.9 后端：hub、录制、实时显示

#### 5.9.1 hub

- 每条（设备，流）只建立**一个** `StreamSource`，由多个消费者共享：运行中的判定、录制器、运行台显示。
- hub 给每条记录增加 `tb`（后端时间，与 `t` 相同），并把 `gap` 转换为时间区间 `{t0, t1}`。
- 设备未加载或读取失败时报告 `disconnected` 并退避重试；未知流报告 `unknown_stream`。

#### 5.9.2 录制器

- 每次测试运行的流记录写入 `runs/<runId>/run.sqlite`（WAL 模式，与运行日志同一个文件，第 9.5 节）。
- 流表：
  - `meta`；
  - `streams(key, type, clock, count, watermark, watermarkTb, maxSpan)`；
  - `records(i, key, seq, t, tEnd, tb, op, data)`；
  - `gaps`、`states`、`blobs`。
- 运行开始前预录 1000 ms，结束后补录 500 ms。
- 录制的是**原始记录**。协议层派生的字段不单独存储，需要时由 ICD 重新计算（第 6.4 节）。
- 实现：`streams/recorder.py`、`store.py`。

#### 5.9.3 实时显示

- 渲染进程订阅 SSE `GET /api/live?keys=<k1,k2>&width=<像素宽>&window=<ms>`：
  - 后端从 hub 取数，按屏幕像素宽做 min/max 抽稀（每个像素列给出最小值和最大值），曲线形状不失真，传输量与采样率无关；
  - 每 50 ms 推一帧增量，帧里带各流的水位线和 `gap` 区间；
  - 断线后带 `Last-Event-ID` 续传；关闭连接即结束订阅，不需要会话回收。
- 回看已录制的数据走普通操作 `streams.window(runId, keys, t0, t1, width)`，同样返回 min/max 抽稀结果。

### 5.10 调试接口

`<prefix>_stream_read(streamId, fromSeq?, limit=200)` 分页读取记录，供 Agent 和手动调试使用。它不消费记录，不影响 hub。

---

## 6. 被测产品协议层（ICD 解码层）

### 6.1 位置与职责

- 位于后端 `teststand_backend/protocol/`，处在 hub 与判定、显示之间（第 2.3 节图）。
- 输入：原始 `bytes`/`frames` 流。
- 输出：**派生字段流**。
- 与被测产品一一对应：换产品只换 ICD 文件，不改设备插件，也不改平台代码。

历史项目中大量测试项的证据是 DUT 通过串口或 1394 报回的字段（C-06～C-09，D-01、D-08～D-21 等）。没有这一层，这些测试项只能靠正则匹配文本，无法判定二进制协议中的数值。

### 6.2 ICD 文件

ICD 保存在项目目录 `icd/<name>.icd.yaml`，是纯数据，结构由 JSON Schema 校验：

```yaml
formatVersion: 1
name: dut_cmd
description: DUT 命令口 RS422 协议
transport: bytes                 # bytes：需要切帧；frames：已经是报文
framing:                         # 仅 bytes 需要
  kind: header_length            # header_length | delimiter | fixed | slip | cobs
  header: "AA 55"
  lengthField: {offset: 2, size: 1}
  lengthCovers: payload          # payload | from_header | whole
  trailer: checksum
  maxLength: 260
checksum:
  algorithm: crc16_modbus        # 只能从命名算法表中选（第 6.3 节）
  range: {from: 2, to: -2}       # 负数表示从帧尾倒数
  offset: -2
  endian: little
messages:
  - name: status
    match: {offset: 3, value: 0x81}      # frames 用 {id: 0x123}；可以组合多个条件
    fields:
      - {name: selfTest, offset: 4, type: u8, bits: "0", enum: {0: fail, 1: pass}}
      - {name: voltage,  offset: 5, type: i16, endian: little, scale: 0.01, unit: V}
      - {name: temp,     offset: 7, type: i16, endian: little, scale: 0.1, unit: degC}
      - {name: version,  offset: 9, type: ascii, length: 8}
  - name: ack
    match: {offset: 3, value: 0x01}
    fields:
      - {name: code, offset: 4, type: u8}
encoders:                         # 可选：用于组帧发送
  - name: set_mode
    template: {header: "AA 55", cmd: 0x10}
    fields: [{name: mode, offset: 4, type: u8}]
```

- 字段类型：`u8/i8/u16/i16/u32/i32/u64/i64/f32/f64`、`ascii`、`bytes`、位域 `bits: "3..5"`。
- 变换：`scale`、`offset`、`enum`、`unit`，以及可选的 `expr`（使用第 7.3 节的表达式语言，只能引用本帧字段）。
- 1553B、429、CAN 按 `id` 匹配，结合第 5.4 节的编码。
- 【目标】复杂的变长结构可以使用 Kaitai Struct（`.ksy`），作为扩展格式。

### 6.3 校验算法表

算法只能从平台内置的命名表中选择，禁止在 ICD 中自定义多项式代码：

| 名称 | 参数（width/poly/init/refin/refout/xorout） |
|---|---|
| `sum8` | 各字节求和，取低 8 位 |
| `sum8_neg` | 求和后取补码 |
| `xor8` | 各字节异或 |
| `crc8` | 8/0x07/0x00/false/false/0x00 |
| `crc16_modbus` | 16/0x8005/0xFFFF/true/true/0x0000 |
| `crc16_ccitt_false` | 16/0x1021/0xFFFF/false/false/0x0000 |
| `crc16_xmodem` | 16/0x1021/0x0000/false/false/0x0000 |
| `crc16_kermit` | 16/0x1021/0x0000/true/true/0x0000 |
| `crc32` | 32/0x04C11DB7/0xFFFFFFFF/true/true/0xFFFFFFFF |

- 参数取自 CRC RevEng 目录。平台必须用目录中的“check”值（对 ASCII `123456789` 的结果）做单元测试。
- 需要新算法时，扩充此表并附上 check 值。

### 6.4 派生流

- ICD 绑定到一条原始流：计划或项目中声明 `protocolBindings: [{icd: dut_cmd, source: {hardwareId, streamId: serial1}, alias: dut}]`。
- 解码产生：
  - `dut.<message>`：frames 形式的派生流，每条记录为 `{t, seq(原始), op, fields{…}, raw, checksumOk}`；
  - `dut.<message>.<field>`：scalar 形式的派生流（数值字段）。
- 派生记录继承原始记录的 `t`、`op`；原始流的水位线和缺口原样传递。
- 校验失败的帧**不丢弃**：
  - 它们进入 `dut.$errors` 派生流，便于诊断；
  - 字节中无法切分的部分记为 `dut.$unframed`。
- **确定性**：同样的原始记录和同样的 ICD，必须得到同样的派生结果。录制只存原始数据，报告中记录 ICD 的哈希，重新判定时重新解码。
- 判定步骤（Observe/Expect/Guard）可以直接引用派生流，例如 `streamId: dut.status.voltage`。

### 6.5 组帧发送

- `InvokeTool` 可以使用 `encode: {icd: dut_cmd, message: set_mode, fields: {mode: 2}}` 代替原始的十六进制 `data`。
- 后端按 ICD 组帧、计算校验，再调用设备插件的发送工具（`<prefix>_transact` 或 `<prefix>_send`）。
- 插件看到的仍然只是字节。

---

## 7. 测试语义

### 7.1 计划结构

```jsonc
{"schemaVersion": 2,
 "parameters": { … },            // 输入参数及其 schema
 "requirements": [ … ],          // 需要的设备与工具
 "bindings": { … },              // 逻辑名 → 实际设备（第 7.6 节）
 "protocolBindings": [ … ],      // 第 6.4 节
 "stopOnFail": true,
 "regions": {"prepare": [ … ], "test": [ … ], "cleanup": [ … ]}}
```

- `cleanup` 区域在正常结束、失败、中止时都会执行。
- 计划先编译再执行。编译会解析工具绑定（`bindingRevision = schema 哈希`），工具 schema 变化时，编译会报告需要重新绑定。

### 7.2 步骤目录

| 步骤 | 关键参数 | 输出 `steps.<id>.*` |
|---|---|---|
| `Sequence` / `Group` | children | — |
| `Parallel` | children | — |
| `If` | condition, elseChildren | — |
| `Repeat` | count | — |
| `ForEach` | itemsExpression；子步骤中可以使用 `item`、`index` | — |
| `Retry` | attempts 1～20, delayMs；**禁止包住结果可能未知的 actuate**，由编译检查（`retry.unsafe`） | — |
| `SetVariable` | variable, valueExpression | — |
| `Evaluate` | expression | value |
| `Delay` | durationMs | — |
| `InvokeTool` | hardwareId（或绑定名）, toolName, arguments, timeoutMs=30000, errorPolicy, anchor, assertions, `encode` | result, timing, streamRefs |
| `Observe` | hardwareId, streamId, window{anchor, startMs, endMs}, assertions, minSamples=3 | 统计量、verdict |
| `Expect` | hardwareId, streamId, anchor, offsetMs, withinMs, match, `capture` | verdict, matchT, latencyMs, record, `captures` |
| `Guard` | hardwareId, streamId, condition, onViolation abort\|fail；包住子步骤 | verdict, 违规记录 |
| `ManualCheck` | prompt, images?（参考图）, options（默认 通过/不通过/无法判断）, requireNote, timeoutMs? | verdict, note, operator, t |
| `PublishResult` | value / valueExpression, unit, metadata, verdict | — |

- 断言运算符：`lt le gt ge eq ne within outside matches contains`，容差可以是绝对值或百分比。
- `ManualCheck.images` 是给操作员看的参考图（项目文件），与测试资源无关，保留。

### 7.3 表达式

- 语言为 CEL 的安全子集，基于 Python AST 实现：
  - 运算：`&& || !`、比较（含链式）、`in`、四则运算与取模、位运算 `& | ^ << >> ~`、属性和索引访问、列表和字典字面量。
  - 上下文：`parameters`、`variables`、`steps`、`item`、`index`。
- 函数（纯函数，无副作用）：

  | 类别 | 内容 |
  |---|---|
  | 数值 | `abs`、`min`、`max`、`round(x, n)`、`floor`、`ceil`、`sqrt` |
  | 转换 | `int(x)`、`int(s, base)`、`float`、`str`、`hex(x)` |
  | 集合 | `len`、`sum`、`all`、`any`、`sorted` |
  | 位 | `bit(x, n)`、`bits(x, lo, hi)` |
  | 字节 | `bytes_hex(s)`、`u8`/`i8`、`u16le`/`u16be`、`i16le`/`i16be`、`u32le`/`u32be`、`i32le`/`i32be`、`f32le`/`f32be`（复杂的解析应放进 ICD） |
  | 字符串 | `startsWith`、`endsWith`、`contains`、`matches`、`split`、`trim` |

- 禁止：I/O、时间函数、随机数、任意属性反射。表达式必须能在编译期完成类型检查。

### 7.4 Observe 的统计量

- 按流类型提供，见 `streams/judge.py`。scalar 有 `mean`、`min`、`max`、`p2p`/`pp`、`rms`、`std`、`first`、`last`、`count`。
- 波形指标（scalar/block）：

  | 指标 | 说明 |
  |---|---|
  | `freq`、`period`、`duty` | 基于过零或迟滞比较，参数 `threshold` 与 `hysteresis`（默认：窗口中点与峰峰值的 5%） |
  | `riseMs`、`fallMs` | 10%～90%（默认在窗口最小值与最大值之间），精度受采样率限制，报告中注明 |
  | `settleMs` | 进入容差带 `band` 并保持的时刻 |

- 跨流指标：判定器已提供两条流之间的延迟（互相关）、相位差、比值（`judge.compare`）。【目标】增加步骤 `Compare` 或 Observe 的 `reference` 参数，把它接入计划。两个锚点的不确定度相加。

### 7.5 Expect 捕获

- `capture` 从命中的记录中提取值，保存到 `steps.<id>.captures.<name>`：

  ```yaml
  capture:
    version: {regex: "VER=(\\S+)", group: 1}     # bytes：对 text 做正则
    code:    {field: "fields.code"}              # 派生流：取字段
    raw:     {field: "data"}
  ```

- 后续步骤可以用 `steps.<id>.captures.version` 做断言或计算，替代“读缓存找字段”的做法（A-01、A-02、D-01）。编译期检查引用的捕获名存在。

### 7.6 绑定表（多工位复用）

- 计划中使用逻辑名，例如 `psu_main`、`dut_uart`，通过 `bindings` 映射到实际的 `hardwareId` 和流：

  ```yaml
  bindings:
    psu_main: {hardwareId: IT6952A_0}
    dut_uart: {hardwareId: CP118U_I_CARD_0, streamId: "serial${station}"}
  ```

- 批量运行（`start_test_batch`）为每个工位提供一组绑定值，例如 `station: 1..8`，逐工位预检后运行。这一机制覆盖项目 C 的“8 工位轮询”。
- 编译时先展开绑定再校验：设备存在、工具存在、流存在。

### 7.7 判定与证据

- 判定结果：`pass`、`fail`、`inconclusive`。

  | Inconclusive 原因 | 含义 |
  |---|---|
  | `watermark_timeout` | 水位线在限定时间内没有越过窗口末尾 |
  | `gap` | 窗口内有数据缺口 |
  | `insufficient_evidence` | 样本数不足 |
  | `clock_uncertainty` | 锚点不确定度（第 5.8 节）使窗口收缩后为空，或跨流比较的结果落在不确定度之内 |
  | `operator_undecided` | 人工判定选择“无法判断”或超时 |

- 窗口锚点来自工具结果的 `timing.end`（与流记录同一时钟）；没有设备计时时取后端记录的调用结束时刻，并带调用耗时作为不确定度。
- 判定时，后端等待水位线越过 `窗口末尾 + 不确定度`，最长等待 `max(2 s, 窗口宽度)`。
- 证据分级（写入每条判定结果的 `evidenceType`）：

  | 级别 | 内容 |
  |---|---|
  | T1 | 独立测量：采集卡、仪器直接测 DUT |
  | T2 | 仪器自测：电源 `MEAS:VOLT?` |
  | T3 | 仪器内部的精密测量结果，例如示波器测得的上升时间 |
  | P | DUT 协议回报 |
  | M | 人工判定 |
  | S | 设定值影子，**只能用于显示，不能作为判定证据**，编译时拒绝（`evidence.setpoint`） |

- 所有判定保存窗口参数、样本引用（`key` + `seq` 范围）和结果。报告可以离线重新判定。

### 7.8 未知结果与核销

- `actuate` 调用超时、隔离子进程退出或返回 `invalid_response` 时，结果为**未知**（`unknown_outcome`）。
- 该调用进入恢复列表，运行暂停或按策略中止。
- 由人或 Agent 调用 `reconcile_test_operation`，并附上依据（例如观察到的流数据），把结果确认为已执行或未执行。该操作需要界面确认。
- **禁止自动重发。**

---

## 8. AI Agent 设计

### 8.1 组成

- 使用 OpenCode 作为 Agent 外壳，连接本地的 OpenAI 兼容模型服务。OpenCode 进程由 Python 后端启动和管理，后端注入 LLM 密钥与网关令牌，并提供 Agent 指令文本。
- 后端的 `mcp_gateway` 在 `127.0.0.1` 上提供 MCP 服务（默认端口 8000）：
  - 只接受回环地址的连接，并校验 Host、Origin 和 Bearer 令牌（凭据库条目 `gateway`）；
  - 请求必须带工作模式 `?mode=`（第 8.2 节）；
  - 请求体上限 1 MB。
- 网关是操作注册表的一个接入适配器（第 9.3 节）：内置工具由注册表生成；权限、确认、审计与界面走同一条中间件路径。
- 技能文档 `skill/device-plugin/` 教 Agent 编写设备插件：流程、契约、SDK API、模板、检查脚本。技能文档必须与本文第 4、5 章保持一致。

### 8.2 工作模式与工具配置

本地模型能力有限，工具过多会导致选错工具。网关按**模式**提供工具子集：

| 模式 | 典型任务 | 提供的工具 |
|---|---|---|
| `adapter` | 编写或调试适配器 | 设备声明读取、设备类型列表、按需展开的单台设备工具 |
| `plan` | 编写测试计划 / ICD | 项目、设备注册表、`get_hardware_definition`、步骤目录、计划的校验和编辑、ICD 校验和试解码、流观察 |
| `run` | 运行、分析、核销 | 运行控制、结果和事件读取、`testing_read_run_io`、恢复与核销 |
| `explore` | 手动调试设备 | 目标设备的工具（按需展开）、`observe_stream`、`expect_stream` |

- 各模式包含哪些内置工具，由操作注册表中每个操作的 `profiles` 字段决定，不在网关中另写清单。
- 设备工具默认不平铺。`list_device_tools(hardwareId)` 和 `enable_device_tools(hardwareId)` 只在 `adapter`、`explore` 模式提供，由 Agent 按需展开单台设备的工具；`run` 模式中不展开设备工具，动作只能通过计划执行。

### 8.3 声明读取

- Agent 通过网关的 `get_hardware_definition(hardwareId)` 读取设备声明。其内容来自后端缓存的 `/device`，包括引脚和流清单。
- Agent 不直接调用设备插件，只经网关。

### 8.4 安全边界

| 规则 | 实现 |
|---|---|
| 能力控制 | 每个网关工具绑定一项能力，例如 `hardware.read`、`hardware.executeTools`、`hardware.manage`、`testing.execute`。用户在设置中授权 |
| 高风险操作确认 | `confirm=True` 的操作（核销 `testing.reconcileOperation`、删除设备实例与硬件定义、删除计划）由 Agent 调用时，需要在界面上确认（`application/confirmations.py`，超时 300 s 视为拒绝） |
| 参数安全范围 | 适配器在工具内做范围检查，例如电压上限；后端不得绕过 |
| 未知结果 | Agent 不能重发，只能核销（第 7.8 节） |
| 适配完成门槛 | 适配器状态从“开发中”到“可用”，必须满足三点：`--check` 通过、模拟器测试通过、有一条**人工实物冒烟记录**（执行人、时间、接线、观察结果）；记录在设备注册表的 `adapterStatus` 中 |

---

## 9. 终端软件架构

本章规定测试终端（Python 后端 + 桌面界面）的内部结构。第 4～8 章规定的是“做什么”，本章规定“代码怎么组织”。

### 9.1 总体形态

```
┌──────────── Python 后端（一个进程，可脱离界面运行）──────────────────┐
│ 接入层：HTTP API │ Agent MCP 网关                                    │
│            ▲ 两者都由同一个操作注册表生成（第 9.3 节）               │
│ 应用层：设备清单 · 计划 · 运行 · 报告 · ICD · 执行协调 · OpenCode 管理 │
│ 领域层：计划 IR · 编译器 · 解释器 · 判定器 · 表达式 · 协议解码        │
│ 资源层：设备宿主（插件）· 流 hub · 运行存储 · 系统凭据库 │
└──────────────────────────────────────────────────────────────────┘
      ▲ HTTP + SSE（127.0.0.1，单 token）       ▲ MCP（127.0.0.1）
 Electron 界面（只负责显示）               OpenCode Agent
```

- 后端是终端的全部业务逻辑，**不依赖界面**。两种使用方式：
  - 桌面应用：Electron 启动后端，界面通过 HTTP + SSE 访问；
  - 浏览器（可选）：后端把构建好的前端作为静态资源提供，供同一台电脑之外的只读查看。默认只监听 `127.0.0.1`，对外监听必须在设置中显式开启，并且仍校验令牌。
- Electron 界面只负责显示和原生能力，不包含业务规则（第 9.6 节）。入口：`host/__main__.py`、`http_api.py`。

### 9.2 分层与模块

| 层 | 职责 | 可以依赖 | 现有包（`B\…`） |
|---|---|---|---|
| 接入层 | 把注册表中的操作暴露为 HTTP、MCP；鉴权、编解码 | 应用层、注册表 | `host`、`mcp_gateway` |
| 应用层 | 用例：设备清单、计划、运行、报告、ICD、项目与接线、执行协调 | 领域层、资源层 | `application`、`devices\device_service.py`、`device_catalog_service.py`、`projects`、`wiring`、`testing\application.py`、`testing\store.py` |
| 领域层 | 纯逻辑：计划 IR、编译器、解释器、判定器、表达式、协议解码。不做 I/O | 无（只依赖标准库和 Pydantic） | `testing\compiler.py`、`interpreter.py`、`expression.py`、`models.py`、`streams\judge.py`、`protocol` |
| 资源层 | 外部连接和持久化：设备插件传输、流 hub、运行存储、凭据库 | 无业务依赖 | `devices\plugin_transport.py`、`tool_catalog.py`、`device_store.py`、`streams\source.py`、`clock.py`、`recorder.py`、`store.py`、`storage` |
| 契约 | 各层共用的数据模型和错误码 | 无 | `contracts` |

- 依赖只能自上而下；领域层不得导入资源层。用 import-linter 检查（`app/python/pyproject.toml` 中 4 条契约：接入层不被下层导入、领域层不做 I/O、资源层无业务依赖、契约层不依赖其他层），前端用 dependency-cruiser 做同样的检查。
- 领域层中的解释器通过接口调用资源（“调用一个设备工具”“读某条流的窗口”“追加一条日志”），接口的实现由应用层注入。测试时注入假实现，不需要硬件。

### 9.3 操作注册表

后端对外的每个操作（给界面、给 Agent）只在一处定义：

```python
class StartRunRequest(BaseModel):
    planId: str
    stationBindingId: str
    dryRun: bool = False

@operation(
    "runs.start",
    capability="testing.run",      # 需要的能力（第 8.4 节）
    risk="actuate",                # read | write | actuate | destructive
    profiles={"run"},              # 出现在哪些 Agent 工作模式中（第 8.2 节）
    idempotency="request-id",      # none | natural | request-id
    confirm=False,                 # Agent 调用时是否需要界面确认
)
async def start_run(ctx: OpContext, req: StartRunRequest) -> RunRef: ...
```

- 参数和返回值都用 Pydantic 模型，**按字段名传参**。注册表是一个普通的字典，按名称索引，启动时一次性收集，不在调用时反射查找。定义在 `contracts/operations.py`，注册表在 `application/registry.py`。
- 由注册表生成：

  | 目标 | 形式 |
  |---|---|
  | HTTP | `POST /api/ops/{name}`，请求体就是请求模型的 JSON |
  | OpenAPI | `packages/contracts/openapi.json`，与 `operations.generated.ts` 一起由 `python/scripts/generate_operations.py` 生成；前端的请求/响应类型由 `openapi.json` 生成，生成文件提交到仓库，CI 检查是否过期 |
  | MCP 工具 | 名称把 `.` 换成 `_`（`runs_start`）；`inputSchema` 取自请求模型；`annotations` 由 `risk` 推出（`readOnlyHint`、`destructiveHint`、`idempotentHint`）；按 `profiles` 分到各工作模式 |

- 中间件对所有入口一致生效，顺序固定：
  1. 解析和校验请求模型，失败返回 `invalid_argument`；
  2. 检查能力（调用方是界面用户或 Agent，各自有授权集合）；
  3. `confirm=True` 且调用方是 Agent 时，挂起并请求界面确认；
  4. 幂等：带 `requestId` 的请求先查请求账本（`claim_request`/`complete_request`），已完成的直接返回原结果；
  5. 执行；
  6. 写审计日志（`storage/audit_log.py`：调用方、操作、参数摘要、结果、耗时；JSONL，5 MB 轮转），敏感字段按模型上的标记脱敏；
  7. 对 `risk="actuate"` 的操作，如果结果未知（超时、子进程退出），返回 `unknown_outcome`，**任何入口都不自动重试**（第 7.8 节）。
- 设备工具（`<deviceId>__<tool>`）不在注册表中：它们来自已加载插件的工具描述，由网关按需展开（第 8.2 节），但调用时同样经过第 2、3、6、7 步。

### 9.4 前后端通信

| 通道 | 用途 |
|---|---|
| 主进程 ← 后端 stdout，**一行** | 启动握手：后端就绪后打印 `{"port": …, "token": "…"}`（另带版本号），之后 stdout 不再承载任何协议，只作为日志输出 |
| 主进程 → 后端 stdin | 关闭 stdin 即通知后端退出 |
| 渲染进程 → 后端，HTTP | `POST /api/ops/{name}`，具名 JSON 请求体，`Authorization: Bearer <token>`；用生成的类型调用 |
| 后端 → 渲染进程，SSE | `GET /api/events`：领域事件（设备、计划、运行、项目文件变化），带 `id`，支持 `Last-Event-ID` 续传 |
| 后端 → 渲染进程，SSE | `GET /api/live?keys=…&width=…&window=…`：实时曲线数据，后端抽稀（第 5.9.3 节） |
| 渲染进程 ↔ 主进程，Electron IPC | 仅限：文件和目录对话框、窗口控制、自动更新、把握手得到的地址和令牌交给预加载脚本 |

- 只有一个令牌（握手得到的 `token`），界面和主进程用同一个；令牌只放在 `Authorization` 头中，不接受查询串。CORS 只允许渲染进程的 origin。全部只监听 `127.0.0.1`。
- 主进程和后端之间没有回调通道。密钥由后端自己访问系统凭据库（第 4.7 节）。
- 后端退出时主进程显示错误并提供“重启服务”；主进程退出时关闭 stdin，后端收尾测试运行后对所有已打开设备执行 `safe_state`（第 4.6 节）再退出。
- 事件只表示“某资源变了”，带资源键和新版本号，不携带完整数据；界面据此让相应查询失效后重新读取（第 9.6 节）。这样事件丢失时只需全量刷新，不会出现不一致。

### 9.5 运行日志与运行存储

每次运行的全部事实按时间顺序追加进**运行日志**，日志是唯一记录：

```
run.started(planHash, stationBinding, operator)
  region.started / step.started(stepId, attempt)
    operation.accepted(opId, target, tool, args) → operation.dispatched(opId)
    operation.succeeded(opId, timing) │ 失败或结果未知时不写
    anchor.set(anchor)
    result.published(stepId, checkId, pass|fail|inconclusive, evidence{streamKey, t0, t1})
    manual.requested / manual.answered
  step.completed(stepId, outcome) / region.completed
  run.cleanupStarted · safety.started / safety.completed · run.safetyVerified
  operation.reconciled(opId, decision, by)
run.completed │ run.aborted │ run.error
```

- 每条日志有递增序号和后端时间 `tb`；`opId` 在发出调用**之前**写入 `operation.accepted`，派发时写 `operation.dispatched`，成功返回后写 `operation.succeeded`。
- 信息从日志推导：

  | 需要的信息 | 推导方式 |
  |---|---|
  | 运行状态、当前步骤、进度 | 从头折叠日志 |
  | 崩溃恢复 | 重新打开日志并折叠；最后一步未结束则按第 7.8 节处理 |
  | 待核销列表 | 已 `operation.dispatched`、结果未知且没有 `operation.reconciled` 的调用。【目标】目前取自项目级索引 `.teststand/runtime.sqlite3` 的 `operations` 表，尚未改为折叠日志 |
  | 报告 | 由日志和计划生成，可随时重新生成 |
  | 重新判定 | 取判定中的证据区间，对录制的原始数据重跑判定器，结果作为新的判定版本，不改原日志 |

- 存储：`runs/<runId>/run.sqlite`，WAL 模式，包含日志表 `journal(seq, tb, kind, stepId, opId, body)`、`results`、`snapshots`（计划、接线、绑定表、摘要），以及第 5.9.2 节的流记录表。**一个文件就是一次运行的完整证据包**，可以拷走、归档、离线重判。旧布局（`events.jsonl`、`results.jsonl`、`streams.sqlite`）不再读取。
- 项目级 `.teststand/runtime.sqlite3` 只作索引：请求账本、操作索引、运行索引、批量运行、接线任务。
- 引擎拆成三块：
  - **编译器**：计划 YAML + 绑定表 → 计划 IR（纯函数，领域层，`testing/compiler.py`）；
  - **解释器**：按 IR 执行，只通过接口调用设备、读流、写日志（领域层，`interpreter.py`）；
  - **日志存储**：追加写入、折叠、查询（资源层，`journal.py`）。
- 项目文件（计划、ICD、接线、工位绑定表）是项目目录下的 YAML 文本，可以用 git 比较和评审，也方便 Agent 直接编辑。后端负责校验、建索引，并在文件变化时发事件。运行开始时把用到的文件快照进 `run.sqlite`，之后修改项目文件不影响已有运行。

### 9.6 前端

#### 9.6.1 Electron 主进程

- 只做四件事：启动 Python 后端并完成握手、管理窗口、原生对话框、自动更新。OpenCode 进程不归主进程管理（第 8.1 节）。
- 预加载脚本只暴露：API 地址和令牌、对话框、窗口控制、更新状态。不暴露 Node 能力，渲染进程开启 `contextIsolation` 和 `sandbox`。

#### 9.6.2 页面

| 页面 | 内容 | 数据来源 |
|---|---|---|
| 设备 | 扁平的设备列表（插件实例）与被动硬件列表；引脚表、流、能力（只读）；模拟模式与离线缓存标识；按已安装类型“添加测试资源”（type / settings / mode）；手动调用工具 | 设备注册表（缓存的 `/device`）、`devices.listDeviceTypes`；运行态来自 `list_hardware` 与流状态 |
| 台架接线 | 设备卡片、端口、连线；接线任务；工位绑定表 | `/device.pinout`、接线 YAML |
| 计划 | 步骤树、参数、绑定、ICD；表单视图 | 步骤目录、设备工具 schema |
| 运行台 | 左侧步骤树和判定结果；右侧曲线（uPlot）、串口终端视图（xterm.js）、报文表（原始和解码两栏）、派生字段曲线；人工判定对话框 | `/api/events`、`/api/live`、运行日志、协议层派生流 |
| Agent | OpenCode 会话；待确认的高风险操作 | 网关 |

#### 9.6.3 状态管理

- 后端数据全部由 TanStack Query 管理，查询键与操作名对应（例如 `["runs.get", {runId}]`）。前端不另存一份后端数据。
- 维护一张“事件 → 失效查询键”的映射表（`renderer/lib/event-invalidation.ts`），`/api/events` 收到事件后按表让查询失效。新增事件类型必须同时更新映射表，由测试检查覆盖。查询由事件驱动刷新，不做定时轮询，确有必要的除外。
- 前端本地状态只有界面状态（选中项、面板布局、未保存的表单草稿）。

#### 9.6.4 计划编辑器

- 步骤表单根据步骤类型的 JSON Schema 和设备工具的 `inputSchema` 自动生成（复用 `features\manual\SchemaForm.tsx`），新增步骤类型不需要改前端。
- 【目标】同时提供 YAML 文本视图（Monaco），用同一份 schema 做补全和校验。两个视图编辑的是同一份文档。

### 9.7 设备注册表

- **受管设备**（设备插件实例）：定义以 `/device` 为准，后端只缓存，保存在 `devices/hardware/<id>/definition/device.json`，并记录 `manifestRevision`；连接时或修订号变化时更新。
  - 用户不能编辑引脚和流声明。
- **无源设备**（转接箱、线缆、DUT 本身，没有插件）：由用户或 Agent 在终端中定义，使用 `formatVersion 2` 格式和 `.tshw` 包导入导出。
- 设备未加载（打开失败、隔离子进程退出）时使用缓存显示，并标注“离线，显示的是缓存版本”。

### 9.8 测试

- 不做虚拟台架（DEC-18）。各适配器的模拟驱动（`select_driver(real, simulated)`）用于适配器单元测试、`--check`、`mode: sim` 实例和端到端测试；输入读空闲值，不在设备之间回送接线。
- 适配器测试用 SDK 的进程内测试工具 `serve(Device)`：`hh.call` 返回信封、`hh.device()` 返回声明、`hh.subscribe()` 按 `hello`/`batch`/`gap`/`status` 事件读流。
- 桌面应用的端到端测试（Playwright）使用真实 SDK 插件的模拟模式（`mode: sim`），不用假 MCP 服务器。
- 实物台架用于冒烟测试和适配器放行（第 8.4 节“适配完成门槛”）。
- 测试分层：
  - 领域层：纯单元测试，不需要硬件；
  - 应用层 + 接入层：对注册表中每个操作做契约测试（请求模型、错误码、能力检查），并检查 `openapi.json` 与生成的 TS 类型没有过期；
  - 端到端：模拟模式的插件 + 桌面应用；实物冒烟：实物台架 + 桌面应用。

---

## 10. 覆盖范围

依据 `doc/research/` 中四个历史项目，合并后约 65 个测试项（A-01～A-13、B-01～B-05、C-01～C-10、D-01～D-38，其中部分为保留或非测试项）。

| 能力 | 状态 | 可覆盖的测试项 |
|---|---|---|
| 设备工具 + Observe/Expect/Guard（正则匹配文本）+ 独立测量 | 已实现 | 约 23 项：纯电气测量、开关、文本应答类 |
| + 协议层（第 6 章）+ 捕获（第 7.5 节）+ 表达式函数和位运算（第 7.3 节） | 已实现 | 二进制协议字段判定、版本读取、1394/429/1553 报文，累计约 62 项 |
| + 波形指标（第 7.4 节）+ 人工判定（第 7.2 节） | 已实现 | 周期、占空比；视频画面（C-10） |
| + 跨流比较步骤（第 7.4 节） | 【目标】 | 相位（D-37），累计 64～65 项 |
| 需要插件内场景工具的连续联动（B-05 类反应逻辑） | 另行实现场景工具 | — |

| 测试资源类别 | 接入方式 | 状态 |
|---|---|---|
| 采集卡、DA 卡、DIO 卡、继电器卡、串口卡 | 厂商 DLL + ctypes 适配器，或 hwcli 子进程 | 已有 4 个（1710L、1762、6208V、CP118U-I） |
| SCPI 仪器（电源、负载、万用表） | VISA/串口适配器 | 待编写，最易由 AI 生成 |
| 自定义协议模块（调理板、ZT DA/TTL） | 串口适配器 + 适配器内组帧 | 待编写 |
| 总线卡（1553B、429、1394、CAN） | 厂商 DLL 适配器 + frames 流 + 场景工具 | 待编写，难度最高 |
| 视频 | 矩阵适配器 + ManualCheck；自动画质判定不在范围内 | 待编写 |

---

## 11. 决策记录

| 编号 | 决策 | 理由 | 备选及否决原因 |
|---|---|---|---|
| DEC-04 | 判定只在后端 | 跨设备判定、可重新判定、调试与正式运行一致 | 插件内判定：只能看到单台设备，会导致两套判定逻辑 |
| DEC-06 | 波形由插件或硬件生成 | 调度抖动会使逐点推送的波形变形；后端忙或中止时输出失控 | 由测试计划或后端逐点推送：时间精度不可接受 |
| DEC-08 | DUT 协议解码在后端，ICD 是数据 | 设备插件与产品无关；换产品只换 ICD；可以重新解码 | 写在适配器里：适配器与产品耦合；写在计划表达式里：难以维护、容易出错 |
| DEC-09 | 校验算法只能从命名表选择 | 避免 AI 手写 CRC 出错；可以用 check 值测试 | 允许自定义代码：无法保证正确 |
| DEC-10 | 反应式逻辑放在插件内的场景工具 | 延迟和确定性要求超出后端能力 | 在计划中写“观察后动作”：延迟数十毫秒且不确定 |
| DEC-11 | 未知结果只核销，不重发 | 物理动作可能已经发生 | 自动重试：可能重复执行动作 |
| DEC-12 | 适配器完成需要人工实物冒烟测试 | 模拟器无法证明接线、驱动与实物一致 | 只靠模拟器：可能把实物上不工作的适配器标为完成 |
| DEC-13 | 后端是可独立运行的工作站服务，Electron 只负责显示 | 业务规则只放一处；后端不依赖界面，可以单独测试 | 业务逻辑放在 Electron 主进程：无界面时无法运行，Python 与 TS 各写一半 |
| DEC-14 | 一个操作注册表生成 HTTP、MCP 和 TS 类型 | 入口越多，权限、审计、校验越容易漏写；手写类型在重构中反复不一致 | 反射 + 位置参数 + 手写类型（旧做法）：改名和调整参数时无法静态发现错误；tRPC：只覆盖 TS 一侧，Python 后端和 MCP 仍需另写 |
| DEC-15 | 运行日志是一次运行的唯一记录，状态由日志推导 | 恢复、核销、报告、重判需要的都是“发生过什么”；可变状态与日志并存时两者会不一致 | 日志 + 可变状态表 + 结果文件分开存（旧做法）：恢复时要把几处拼起来 |
| DEC-16 | 前后端只用 HTTP + SSE；stdio 只做一行启动握手和退出通知；单 token | 通道越少，一个功能涉及的代码位置越少；SSE 可直接用 curl 调试 | stdio JSON-RPC 双向回调（旧做法）：主进程成为必经中转；WebSocket：需要自定义心跳和重连，而 SSE 自带续传 |
| DEC-17 | 密钥存进系统凭据库（Python `keyring`） | 后端无界面时也要读取令牌；删除主进程回调 | Electron `safeStorage`（旧做法）：只能由主进程解密；明文文件：不安全 |
| DEC-18 | 不做虚拟台架；端到端测试用真实 SDK 插件的模拟模式，实物台架做冒烟（2026-10-03 修订） | 只有一个台架、一个小团队，虚拟台架没有使用者；模拟模式走的是真实插件代码 | 虚拟台架：实现后无人使用；TS 假 MCP 服务器（2026-10-01 版本）：与真实插件行为会分叉 |
| DEC-19 | 测试资源与测试终端在同一台电脑；设备是后端进程内插件（entry point 发现类型，硬件记录决定实例） | 实际使用是一台电脑驱动全部资源，资源很少变动；通用化是为了加新类型，而不是为了在终端之间共享。单机场景下没有项目把每台设备做成网络服务（OpenHTF plugs、QCoDeS Station、ros2_control、OpenTAP 均为进程内） | 每台设备一个 MCP HTTP 服务（原 DEC-01/02/03）：需要部署、令牌、对时、租约、SSE 续传，单机没有收益 |
| DEC-20 | 需要隔离的插件用 stdio JSON 行子进程，父进程用 Job Object 管寿命 | 只为驱动写 stdout、崩溃或独占进程而隔离；stdio 不占端口、不需要令牌，父进程退出时子进程自然结束 | 回环 HTTP：仍需端口、令牌和健康检查；全部子进程：多数驱动没有必要，徒增开销 |
| DEC-21 | 接受后端崩溃时输出停在最后值；不做看门狗。只保证打开后 `safe_state`、正常退出 `safe_all`、测试中止 `safe_state` | 崩溃少见；看门狗进程或硬件看门狗的复杂度高于收益 | 心跳租约兜底（原 DEC-05）：为多终端设计，单机只剩崩溃这一种情况；外部看门狗进程：还要处理它自己的寿命 |
| DEC-22 | 测试资源没有外观图和端口图；接线只用结构化引脚数据 | 图片链路（适配器资源、哈希、缓存、上传、协议）维护成本高，接线不依赖它 | 插件提供图片：链路长、无人使用。手动检查步骤的参考图和 Agent 附件保留，它们不是设备声明 |
| DEC-23 | 不做租约；运行与手动控制的互斥由 `ExecutionCoordinator`，单设备串行由 `io_lock`/操作锁 | 单机只有一个后端，进程内互斥足够 | 租约（原 DEC-05）：防的是多终端争用，单机不存在 |
| DEC-24 | 设备类型以 `.tsdev` 设备包交付：wheel 解压到用户数据目录并加到 `sys.path`；安装前显示清单由人确认，不做签名；升级与卸载在重启后生效 | 新增设备不应要求重新打包 testStand；wheel 是 Python 生态现成的分发格式，解压即可导入；台架单机使用，清单确认足够 | 每台设备一个独立进程或独立环境：成本高；签名：要管理密钥；运行中热替换：已导入模块无法安全卸载 |

DEC-01（声明走 HTTP、动作走 MCP、数据走 SSE）、DEC-02（一台设备一个服务进程）、DEC-03（数据面用 SSE）由 DEC-19、DEC-20 取代；DEC-05（心跳租约）由 DEC-21、DEC-23 取代；DEC-07（终端统一部署管理）随远程机制一起删除（DEC-19）。这些编号不再复用。

---

## 12. 代码对齐清单

路径前缀：
- `SDK` = `devices/sdk/src/teststand_device_sdk`
- `B` = `app/python/src/teststand_backend`
- `D` = `app/apps/desktop/src`

本章只列本文与代码的对齐情况。随单机插件化重构作废的条目（设备图片 S2、A1；租约 S5、B6、B7、U3；远程部署与服务管理 R1～R5、B1～B4、U2 的部署部分）已删除。

### 12.1 SDK 与适配器

| 编号 | 对应章节 | 内容 | 状态 |
|---|---|---|---|
| S1 | 4.3 | `/device` 由类属性、`pinout()`、`capability_details()`、流注册表和工具表生成，计算 `manifestRevision`（`SDK/manifest.py`） | 完成 |
| S3 | 4.3.3 | 删除 `get_pinout`、`list_streams` 工具；`--check` 拒绝它们 | 完成 |
| S4 | 5.2 | 流声明带 `unit/width/bitLabels/rateHz/writable/idScheme/label/kind`（`SDK/streams.py`） | 完成 |
| S6 | 5.6 | `waveform_capability`、`SoftwareWaveform`（`SDK/waveform.py`）；由适配器在 `safe_state` 中 `stop_all()` | 完成 |
| S7 | 5.7 | SDK 中不含判定或比较逻辑 | 完成 |
| S8 | 5.5.3 | `ByteStream`/`FrameStream.idle()`；`--check` 检查读线程推进水位 | 完成 |
| S9 | 4.4.4 | `CONTRACT_REVISION = "2026-10-01.1"` | 完成 |
| S10 | 8.1 | 技能文档 `skill/device-plugin/` 改为设备插件技能（entry point、isolation、模拟、合规检查） | 完成 |
| S11 | 4.1、4.2 | `DeviceHost`、entry point 组 `teststand.devices`、`device_types`/`load_device`、`Device.isolation`（`SDK/host.py`、`device_types.py`、`device.py`） | 完成 |
| S12 | 4.5 | `open_device`、`InprocDevice`、`SubprocessDevice`（stdio JSON 行、fd 1 → stderr、stdin EOF 安全收尾、Job Object）、`child.py`（`SDK/plugin.py`） | 完成 |
| S13 | 4.1 | 删除 HTTP 外壳（`app.py`、`sse.py`、Bearer、`/health`、`/time`、`/admin/shutdown`、uvicorn 入口），去掉 FastMCP/Starlette/uvicorn 依赖；`--check` 改为进程内 | 完成 |
| A2 | 5.2 | 流声明补充 `unit`、`width`、`kind` | 部分完成：1710L 的 `do`、1762 的 `relay`、CP-118U-I 的 `serial*` 尚未声明 `kind`（取值按回读语义确定） |
| A3 | 5.6 | pci6208v：`set_waveform`/`stop_waveform`（software，`maxUpdateHz ≤ 200`）；`safe_state` 先停止波形 | 完成 |
| A4 | 5.5.3 | cp118u_i：读线程每次读取返回后调用 `idle()` | 完成 |
| A5 | 4.1 | 四个适配器声明 entry point；6208V `isolation = "subprocess"`，其余 `inproc` | 完成 |
| A6 | 4.5 | 1710L/1762 的 `hwcli_*.exe` 源码（`.cpp`）从未入库，台架上经 `settings.hwcliPath` 使用现成的可执行文件 | 未完成：源码入库或重写 |

### 12.2 后端

| 编号 | 对应章节 | 内容 | 状态 |
|---|---|---|---|
| B5 | 9.7 | 连接或 `manifestRevision` 变化时缓存 `/device`；受管设备只读 | 完成 |
| B8 | 6 | `B/protocol/`：ICD schema、切帧、校验算法表（含 check 值测试）、解码、组帧、派生流接入 hub/judge | 完成；Kaitai 扩展为【目标】 |
| B9 | 7.3 | 表达式函数和位运算，编译期检查 | 完成 |
| B10 | 7.5 | Expect `capture` 与 `captures` 输出 | 完成 |
| B11 | 7.2 | `ManualCheck` 步骤、事件与界面对话框；`operator_undecided` | 完成 |
| B12 | 7.6 | 计划 `bindings`、批量运行的工位参数、编译期展开 | 完成 |
| B13 | 7.4 | 波形指标 `rms/pp/freq/period/duty/riseMs/fallMs/settleMs`；跨流比较 `judge.compare` | 部分完成：缺把 `compare` 接入计划的步骤（`Compare` 或 Observe `reference`） |
| B14 | 7.7 | 判定结果写入 `evidenceType`；编译时拒绝以 `setpoint` 流作为证据 | 完成 |
| B15 | 7.2 | 编译检查：`Retry` 内结果可能未知的 `actuate` 不得重试 | 完成 |
| B16 | 8.2 | 工作模式与按需展开（`list_device_tools`/`enable_device_tools`） | 完成 |
| B17 | 8.4 | 设备注册表中的 `adapterStatus` 与冒烟记录 | 完成 |
| B18 | 4.2、4.7 | `PluginTransport`、`tool_catalog.py`、`plugin` 实例记录、`devices.listDeviceTypes`；冻结版 `--device-child` 入口 | 完成 |
| B19 | 5.5、5.8 | 流改为直接读插件环形缓冲（`streams/source.py`）；`SharedClock`，`backend_ms` = SDK `now_ms` | 完成 |
| B20 | 4.6 | 退出时 `DeviceService.safe_all()`；测试中止时 `safe_state` | 完成 |
| B21 | 4.7 | 删除 SSH、远程 shell、部署流水线、服务注册表、生命周期命令、计算机记录、SSE 流客户端与 `/time` 估计、`paramiko`、FireDAP 及 MCP HTTP 客户端 | 完成 |
| B22 | — | 遗留措辞清理：`application/tools.py` 中 `remove_hardware_definition` 的描述仍提“关联图片”；`streams/judge.py` 模块说明仍提“跨服务”；`streams/live.py` 中按时钟不确定度处理的分支在共享时钟下不再触发 | 未完成 |

### 12.3 桌面渲染进程

| 编号 | 内容 | 状态 |
|---|---|---|
| U1 | 设备页：引脚表（只读）、模拟模式与离线缓存标识 | 完成 |
| U2 | 设备页：扁平设备列表；按已安装类型添加实例（type/settings/mode） | 完成 |
| U4 | 运行台：报文表格（原始/解码两栏）、派生字段曲线、`ManualCheck` 对话框 | 完成 |
| U5 | 计划编辑：绑定表、ICD 编辑与试解码 | 完成 |
| U6 | `renderer/lib/event-invalidation.ts` 的注释仍提租约事件 | 未完成（措辞） |

### 12.4 终端架构

| 编号 | 对应章节 | 内容 | 状态 |
|---|---|---|---|
| T1 | 9.3 | 注册表 `@operation(name, capability, risk, profiles, idempotency, confirm)`；按字段名传参；中间件（校验、能力、确认、幂等、审计、未知结果不重试） | 完成 |
| T2 | 9.3、9.4 | `POST /api/ops/{name}`、`openapi.json`；前端类型由 `openapi.json` 生成，删除手写 `BackendApplication` 与位置参数映射；删除 `/api/invoke`、`invoke_operation`、`DESKTOP_METHODS`、`host/codec.py` | 完成 |
| T3 | 8.1、8.2、9.3 | 网关内置工具由注册表生成；工作模式由 `profiles` 决定；设备工具的调用也经过注册表中间件 | 完成 |
| T4 | 4.7、9.4 | Python `keyring`；stdout 一行握手、关闭 stdin 退出；单 token（无 `hostToken`，`desktop.*` 并入普通操作）；删除 stdio JSON-RPC | 完成 |
| T5 | 9.5 | `runs/<runId>/run.sqlite`（日志表 + 快照 + 流表）；旧运行目录不读取 | 部分完成：待核销列表仍取自 `runtime.sqlite3` 的 `operations` 表，未改为折叠日志 |
| T6 | 9.2、9.5 | 引擎拆为编译器、解释器、日志存储；解释器只通过接口调用设备、读流、写日志 | 完成 |
| T7 | 5.9.3 | SSE `GET /api/live`，后端 min/max 抽稀；`streams.window` 回看；删除长轮询 | 完成 |
| T10 | 9.6 | 事件只带资源键和版本号，声明式映射表加覆盖测试，事件驱动失效代替轮询；步骤表单由 JSON Schema 生成 | 部分完成：Monaco YAML 视图未做 |
| T11 | 9.2 | import-linter 检查第 9.2 节的依赖方向 | 完成 |
| T12 | 8.1、9.6.1 | OpenCode 进程由后端启动和管理（注入 LLM 密钥与网关令牌、提供 Agent 指令）；主进程不再管理它 | 完成 |
| T13 | 9.4 | 删除 `?token=` 查询串；CORS 只允许渲染进程 origin | 完成 |

### 12.5 剩余项

按依赖关系排序：

1. B22、U6：遗留措辞清理（无行为变化）。
2. A2：补齐流的 `kind`。
3. T5：待核销列表改为从运行日志折叠。
4. B13：跨流比较步骤，覆盖 D-37。
5. T10：计划的 Monaco YAML 视图。
6. A6：hwcli 源码入库。
7. B8 扩展：Kaitai Struct 格式。
