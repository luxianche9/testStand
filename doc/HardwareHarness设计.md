# HardwareHarness 设计文档

## 0. 文档约定

### 0.1 地位

- **本文件是 HardwareHarness 设计的唯一真源。** 代码、技能文档（`skill/mcp-server/`）、README 与本文件冲突时，以本文件为准，并按第 12 章的对齐清单修改代码。
- 旧设计文档《智能化通用测试软件设计文档》《运行可观测性与数据面设计》已废止，其中仍然有效的内容已并入本文。
- 基础概念的解释见 [基础概念与架构教程](基础概念与架构教程.md)。本文只写规定，不写科普。

### 0.2 用词

| 标记 | 含义 |
|---|---|
| **必须 / 禁止** | 硬性规定，违反即为缺陷 |
| **应** | 默认要求，偏离时要在代码注释或提交说明中写明理由 |
| **可** | 允许但不要求 |
| **【现状】** | 描述当前代码已有的行为 |
| **【目标】** | 本文规定、代码尚未实现的行为；对应第 12 章的对齐项 |

### 0.3 变更流程

1. 设计变更先改本文件，再改代码，二者可以在同一次提交中完成。
2. 重大取舍记录在第 11 章，编号为 `DEC-xx`；编号只增不改，被推翻的决策标注“已废止，由 DEC-yy 取代”。
3. 服务契约版本 `CONTRACT_REVISION` 的变化必须同步修改第 4 章。

### 0.4 修订记录

| 日期 | 内容 |
|---|---|
| 2026-09-30 | 重写为单一设计文档。新增：设备声明接口 `/device`，服务器提供图片和引脚；心跳租约；波形输出；被测产品协议层；终端统一部署管理；测试语义补充 |
| 2026-09-30 | 重写第 9 章终端软件架构：后端作为可独立运行的工作站服务；操作注册表同时生成 HTTP、MCP、CLI 与 TS 类型；运行日志作为唯一记录；前后端只保留 HTTP + SSE；密钥改用系统凭据库；虚拟台架。新增 P9～P10、DEC-13～DEC-18、第 12.6 节 |
| 2026-10-01 | 删除命令行 `hh` 和虚拟台架（原 T8、T9）：没有使用者，维护成本高于收益。DEC-18 改为不做虚拟台架；第 9.8 节只保留测试分层 |

---

## 1. 目标与非目标

### 1.1 目标

HardwareHarness 是一套通用的智能测试软件。目标是用**一套平台 + 每种设备一个适配器 + 每个产品一份测试计划和 ICD**，替代过去每个项目单独开发一套上位机的做法（见 `doc/research/` 中 A、B、C、D 四个历史项目）。

1. **设备接入标准化。** 每台测试资源被封装为一个独立的资源服务器，对外暴露统一的声明、控制和数据接口。适配器应能由 AI 按厂商 SDK 头文件和手册编写，并在模拟器上自测。
2. **测试逻辑数据化。** 测试计划是结构化数据，由步骤树、参数、表达式和断言组成，可以校验、比较、复用，而不是代码。
3. **判定基于证据。** 每个判定都能追溯到带时间戳的原始数据，能够在事后重新判定。证据不足时明确给出 Inconclusive，而不是猜测。
4. **物理安全优先。** 结果未知的物理动作绝不自动重发；任何失联、崩溃、退出都会让设备回到安全状态。
5. **AI 辅助，人负责。** AI 可以编写适配器、ICD 和计划，也可以调试和分析；实物验证和最终放行由人完成。

### 1.2 非目标

| 非目标 | 说明 |
|---|---|
| 微秒级实时控制 | 端到端时间精度为毫秒级（第 5.8 节）。需要微秒级时序的测量由仪器完成，结果作为数值返回 |
| 闭环反应式仿真 | “收到 A 帧后 50 µs 内回 B 帧”这类逻辑不写在测试计划里，而是写在资源服务器的场景工具或模拟器中（第 5.7 节） |
| 通用 SCADA / 监控平台 | 只服务于测试，不做长期工况监控和报警平台 |
| 替代仪器厂商软件 | 仪器的高级功能（例如示波器的协议触发）通过适配器工具暴露，不在终端重新实现 |

---

## 2. 系统总体架构

### 2.1 组成

```
┌──────────────────────── 测试终端（操作员电脑）────────────────────────────┐
│ Electron 桌面应用（只负责显示，第 9.6 节）                                  │
│   渲染进程（React）：设备与服务 / 台架接线 / 计划 / 运行台 / Agent 面板        │
│   主进程：启动工作站服务、窗口、原生对话框、自动更新                          │
│        │ 启动握手（stdout 一行）      渲染进程 ←HTTP /api/ops + SSE→          │
│        ▼                                                                  │
│ 工作站服务（Python，hardwareharness_backend，可脱离界面运行，第 9 章）        │
│   接入层  HTTP API │ Agent MCP 网关  ← 由同一个操作注册表生成                  │
│   应用层  设备清单 · 服务运维 · 租约 · 计划 · 运行 · 报告 · ICD                │
│   领域层  计划 IR / 编译器 / 解释器 / 判定器 / 表达式 / 协议解码               │
│   资源层  MCP 连接池 · 流中枢与对时 · SSH · 运行存储 · 系统凭据库              │
│        ▲ MCP（127.0.0.1）                                                  │
│ OpenCode Agent（本地 LLM，OpenAI 兼容接口）                                 │
└──────┬─────────────────┬────────────────────┬───────────────────┬─────────┘
       │ 声明            │ 控制面             │ 数据面             │ 管理
       │ HTTP GET        │ MCP /mcp           │ SSE /streams/{id} │ SSH
       │ /device /assets │                    │ + GET /time       │
┌──────▼─────────────────▼────────────────────▼───────────────────▼─────────┐
│ 工控机：每台设备一个资源服务器进程（hardwareharness_device_sdk + hh_adapter_x） │
│   厂商 DLL / VISA / 串口 → 板卡与仪器 → 接线 → 被测产品（DUT）                 │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.2 四类接口

资源服务器与终端之间只有四类接口，每类只做一件事：

| 接口 | 协议 | 方向 | 内容 | 频率 |
|---|---|---|---|---|
| **声明** | HTTP GET `/device`、`/assets/*` | 终端读 | 设备是什么：身份、版本、外观图、端口图、引脚、流清单、能力 | 连接时读一次，版本变化时再读 |
| **控制面** | MCP Streamable HTTP `/mcp` | 终端调用 | 做什么：配置、动作、读取、安全、租约 | 每个动作一次 |
| **数据面** | SSE `/streams/{id}`，辅以 `/time` | 服务器推送 | 发生了什么：带时间戳的连续记录 | 持续 |
| **管理** | SSH（部署、启停、日志）；HTTP `/health`、`/admin/shutdown` | 终端操作 | 服务本身的安装和运行 | 运维时 |

> **原则 DEC-01：声明走 HTTP，动作走 MCP，数据走 SSE。** 同一信息只有一个来源。引脚、图片、流清单只从 `/device` 获得，不再有同义的 MCP 工具。

### 2.3 分层与“协议层”的位置

控制面和数据面是**并列的两条通道**，它们之间没有协议层。所谓“协议层”，是叠加在数据面**之上**、位于**终端**的一层：

```
            ┌──────────────── 终端 ──────────────────────┐
  判定/显示  │ Observe / Expect / Guard / 运行台曲线与表格   │
            │        ▲ 字段流 dut.status.voltage ...       │
  协议层     │ 被测产品协议层：按 ICD 把字节/报文解成字段      │ ← DUT 专有，换产品只换 ICD
            │        ▲ 原始 bytes / frames 流               │
  数据面     │ hub：订阅、对时、录制                         │
            └────────▲─────────────────────────────────────┘
                     │ SSE
            ┌────────┴──── 资源服务器（测试资源专有，与 DUT 无关）┐
            │ serial1: {dir: rx, data: "aa5505..."}          │
            └───────────────────────────────────────────────┘
```

- 资源服务器只描述**测试资源**（例如“CP118U 的串口 1 收到了这些字节”），**禁止**内置任何被测产品的协议知识。
- 被测产品协议层（ICD 解码层）属于终端，详见第 6 章。

---

## 3. 设计原则

| 编号 | 原则 |
|---|---|
| P1 | **一台设备一个服务进程。** 进程之间隔离，可以独立部署、升级、重启 |
| P2 | **原始数据优先。** 服务器发布原始测量和原始字节；换算、解码、判定都在终端完成，并保存原始数据以便重新计算 |
| P3 | **判定唯一。** 判定逻辑只存在于终端 `streams/judge`。调试、正式运行、AI 分析都调用同一个判定器 |
| P4 | **时间以服务器为准。** 动作锚点和流记录使用同一台服务器的时钟；跨服务器比较时，由终端换算并携带不确定度 |
| P5 | **未知就是未知。** 结果未知的动作进入核销；证据不足判为 Inconclusive；从不把“没收到”当作“没发生” |
| P6 | **失联即安全。** 租约心跳中断、服务停止、设备重开时都执行 `safe_state` |
| P7 | **声明即数据。** 设备能力、引脚、图片、ICD、计划都是可校验的数据文件，不是代码里的常量 |
| P8 | **AI 可写、可测、不可放行。** AI 产出必须通过自动检查和模拟器测试；标记“适配完成”必须有人工实物冒烟记录 |
| P9 | **一处定义，多处生成。** 终端的每个操作只定义一次（参数、返回、权限、风险），HTTP 接口、Agent 工具和前端类型都从这一处生成，不手写第二份 |
| P10 | **日志即记录。** 一次运行的全部事实都以追加方式写进运行日志；运行状态、待核销列表、报告、重新判定都从日志推导，不另存一份可变状态 |

---

## 4. 资源服务器

### 4.1 进程与包结构

- SDK：`mcp_servers/sdk/src/hardwareharness_device_sdk`，提供 HTTP 服务、工具注册、信封、租约、生命周期、流、SSE、合规检查。
- 适配器：`mcp_servers/adapters/<name>/hh_adapter_<name>/`，包含：

| 文件 | 内容 |
|---|---|
| `adapter.py` | 设备类：工具、流、能力 |
| `driver.py` | 调用厂商 SDK 的真实驱动 |
| `sim.py` | 模拟驱动，行为与真实驱动一致 |
| `pinout.py` | 连接器与引脚声明 |
| `assets/` | 【目标】外观图、端口图 |

- 启动：`python -m hardwareharness_device_sdk --adapter hh_adapter_<name>`。配置文件由环境变量 `HARDWAREHARNESS_SERVER_CONFIG` 指向 `server.json`。
- 自检：`--check` 对适配器做契约合规检查，部署流程必须调用。

### 4.2 HTTP 端点总表

| 路径 | 方法 | 鉴权 | 用途 | 状态 |
|---|---|---|---|---|
| `/health` | GET | 无 | `{healthy, serverId, hardwareId, state, sdkVersion, manifestRevision}` | 现状；`manifestRevision` 为目标 |
| `/device` | GET | Bearer | 设备声明清单（第 4.3 节） | **目标** |
| `/assets/{path}` | GET | Bearer | 声明中引用的图片等静态资源 | **目标** |
| `/mcp` | POST/GET/DELETE | Bearer | MCP 控制面（第 4.4 节） | 现状 |
| `/streams/{streamId}` | GET | Bearer | SSE 数据面（第 5 章） | 现状 |
| `/time` | GET | Bearer | `{serverTime}`，用于对时 | 现状 |
| `/admin/shutdown` | POST | Bearer | 执行 `safe_state` 后退出进程 | 现状 |

- 所有需要鉴权的端点使用同一个 Bearer 令牌，即 `server.json` 中的 `token`。
- `/health` 必须保持无鉴权，以便在没有令牌时也能发现和探测服务。

### 4.3 设备声明 `/device`【目标】

设备声明是**设备管理界面、接线界面和 AI 共同的显示和推理依据**。外观图片和端口图片由服务器提供，终端不再手工维护受管设备的图片和引脚。

#### 4.3.1 结构

```jsonc
{
  "manifestRevision": "sha256:9f2c…",        // 对下面全部内容（含图片字节）求哈希，任何变化都会改变
  "contractRevision": "2026-10-xx.1",
  "identity": {
    "serverId": "PCI1710L_MCP",
    "hardwareId": "PC1_MCP.PCI1710L_CARD_0",
    "manufacturer": "Advantech",
    "model": "PCI-1710L",
    "hardwareRevision": "B1",                 // 可选
    "adapter": {"name": "hh_adapter_pci1710l", "version": "0.3.0"},
    "sdkVersion": "0.4.0",
    "dryRun": false                           // true 表示正在使用模拟驱动
  },
  "description": "12 位多功能采集卡：16 路单端 AI、16 DI、16 DO …",
  "images": {
    "appearance": {"asset": "appearance.png", "mediaType": "image/png", "width": 1200, "height": 800}
  },
  "pinout": {                                 // 与 SDK Pinout 模型一致，并为连接器增加 image 字段
    "activeMode": "single_ended",
    "modes": [ … ],
    "connectors": [
      {"connectorId": "CN1", "name": "SCSI-68", "connectorType": "scsi68", "gender": "female",
       "image": {"asset": "ports/CN1.png", "mediaType": "image/png",
                 "pinPositions": [{"pinId": "CN1.1", "x": 0.12, "y": 0.30}]},   // 可选：在端口图上标出引脚位置，坐标归一化到 0~1
       "pinIds": ["CN1.1", …]}
    ],
    "pins": [ {"pinId": "CN1.1", "connectorId": "CN1", "position": 1,
               "functions": [{"signal": "AI0", "direction": "input", "electricalType": "analog",
                              "channelKind": "ai", "channelIndex": 0, "mode": "single_ended"}]} ]
  },
  "streams": [
    {"id": "ai0", "type": "scalar", "unit": "V", "rateHz": 10, "label": "AI0 电压"},
    {"id": "di",  "type": "bits",   "width": 16, "label": "数字输入"},
    {"id": "serial1", "type": "bytes", "writable": true}
  ],
  "capabilities": { … },                      // 即原 capabilityDetails，含 waveform 等（第 5.6 节）
  "tools": [ {"name": "pci1710l_read_ai", "kind": "read"} ]    // 摘要；完整 schema 以 MCP tools/list 为准
}
```

#### 4.3.2 规则

1. `/device` 的内容由适配器的类属性、`pinout()`、`capability_details()`、流注册表和 `assets/` 目录**自动生成**，适配器作者不手写 JSON。
2. 图片格式限 PNG、JPEG、WebP、SVG；单张不大于 2 MB。`assets` 路径只能指向适配器包内的 `assets/` 目录，禁止 `..`。
3. 缺少外观图或端口图时，`--check` 给出警告而不是错误；终端显示占位图并提示“服务器未提供图片”。
4. `manifestRevision` 变化时（适配器升级、驱动模式切换），终端必须重新拉取并更新注册表，同时使相关计划的 `bindingRevision` 校验重新运行。
5. 分页：引脚数量很大（数百个）时，`/device` 仍返回完整清单，由终端本地分页。原 `get_pinout` 的 `offset/limit` 分页不再需要。

#### 4.3.3 与原 MCP 工具的关系

| 原工具 | 处理 |
|---|---|
| `get_pinout` | 删除，内容并入 `/device.pinout` |
| `list_streams` | 删除，内容并入 `/device.streams`（并新增 `unit` 等字段） |
| `get_server_info` / `get_hardware_info` | 保留为运行态查询：状态、租约、错误计数。静态声明部分改为引用 `/device` |
| `list_hardware` | 保留，一服务一设备时只返回一项 |

AI 通过终端网关读取声明（第 8.3 节的 `get_hardware_definition`），而不是直接调用资源服务器。

### 4.4 控制面：MCP

#### 4.4.1 工具命名与参数

- 设备工具命名为 `<prefix>_<name>`，例如 `pci6208v_set_voltage`。第一个参数必须是 `hardwareId`。
- 终端网关对 Agent 暴露时，名称为 `<serverId>__<toolName>`，并从参数表中去掉 `hardwareId`，由网关注入【现状】。
- 每个工具的描述至少 80 字，必须说明：它证明什么、不证明什么、失败后怎么办。

#### 4.4.2 工具种类 `kind`

| kind | 含义 | 需要租约 | MCP 注解 | 失败后能否自动重试 |
|---|---|---|---|---|
| `read` | 只读，不改变设备 | 否 | `readOnlyHint` | 可以 |
| `configure` | 改变设置，但不产生对外的物理作用（例如设置量程、配置串口参数） | 是 | `destructiveHint` | 仅当工具声明幂等时可以 |
| `actuate` | 产生物理作用（输出电压、闭合继电器、发送报文、启动波形） | 是 | `destructiveHint` | **禁止**（`retry: never_after_dispatch`） |
| `safe` | 回到安全状态 | 否（任何人都可以调用） | `destructiveHint` | 可以（幂等） |
| `internal` | 平台内部使用，例如租约和关停准备 | 视工具而定 | — | — |

每个工具附带 `operationSemantics`：`kind`、`retry`、`stateRequirements`、`stateEffects`、`evidenceType`、`safetyAction`，以及 `outcomeOnInvalidResponse: "unknown"`。

#### 4.4.3 请求 `_meta`

MCP 规范在 `tools/call` 的 `params` 中保留 `_meta` 字段，用来放不属于业务参数的附加信息。本系统使用它传递调用上下文：

```json
{"method": "tools/call",
 "params": {"name": "pci6208v_set_voltage",
            "arguments": {"hardwareId": "PC1_MCP.PCI6208V_CARD_0", "channel": 1, "voltage": 2.5},
            "_meta": {"operationId": "run42.s7.a1", "leaseId": "lease-9c1e…"}}}
```

| 字段 | 必填 | 用途 |
|---|---|---|
| `operationId` | `configure`/`actuate` 必填；其余可选 | 全局唯一的动作编号。服务器把它写进调用期间产生的所有流记录的 `op` 字段，并在结果中返回，用于证据关联和结果核销 |
| `leaseId` | `configure`/`actuate` 必填 | 证明调用者持有租约（第 4.5 节）。附带有效 `leaseId` 的调用同时视为一次心跳 |

- 服务器在 `DeviceService._request_meta()` 中读取 `_meta`【现状】。
- `_meta` 不出现在工具的 `inputSchema` 中，AI 看不到也无需填写，由终端引擎或网关注入。
- `operationId` 格式：测试运行中为 `<runId>.<stepPath>.<attempt>`；手动调用为 `manual.<uuid>`。

#### 4.4.4 结果信封

所有工具返回统一信封（MCP `structuredContent`，同时以 JSON 文本放入 `content`）：

```jsonc
// 成功
{"ok": true, "message": "AO1 已设为 2.500 V",
 "data": {"channel": 1, "voltage": 2.5},
 "meta": {"timestamp": 1790000000102.1, "operationId": "run42.s7.a1",
          "timing": {"start": 1790000000100.2, "end": 1790000000101.9},     // 服务器时钟，Unix 毫秒
          "streamRefs": [{"streamId": "ao1", "fromSeq": 88, "toSeq": 88}]}}
// 失败
{"ok": false, "message": "…",
 "error": {"category": "busy", "message": "…", "retryable": false,
           "details": {"holder": "…"}, "recovery": "…"},
 "meta": { … }}
```

- `timing.end` 是动作的**锚点**：驱动调用返回的时刻，用于第 7 章的时间窗口。
- `streamRefs` 列出这次调用期间写入的流记录范围。
- 错误类别：

| 类别 | 含义 |
|---|---|
| `invalid_argument` | 参数不合法 |
| `not_configured` | 前置配置未完成 |
| `busy` | 租约被他人持有，或设备忙 |
| `device_error` | 驱动报告错误 |
| `device_unreachable` | 设备无法访问 |
| `service_unavailable` | 服务不可用 |
| `invalid_response` | 设备返回无法解析的结果；对 `actuate` 而言，这意味着结果**未知** |
| `not_supported` | 不支持的操作 |
| `internal` | 服务器内部错误 |

- 服务器以 `CONTRACT_REVISION` 标识契约版本。本文的改动（第 4.3、4.5、5.6 节）合入时，必须升级该版本号。

### 4.5 租约

#### 4.5.1 语义

> **DEC-05：租约一经获得即持续占有，没有业务时限；靠心跳证明持有者存活，心跳中断即自动释放。**

| 项目 | 规定 |
|---|---|
| 粒度 | 一台设备（一个 `hardwareId`）同时最多一个租约 |
| 持有者 | **终端实例**，而不是一次测试运行。`holder = {terminalId, user, host, label}`；`terminalId` 是终端首次启动时生成并持久保存的 UUID |
| 获取 | `lease_acquire(hardwareId, holder)` → `{leaseId, holder, acquiredAt, heartbeatIntervalMs: 2000, timeoutMs: 10000}`。设备已被其他持有者占用时返回 `busy`，`details.holder` 给出当前持有者 |
| 同一持有者重复获取 | 返回已有的 `leaseId`（幂等），便于终端重启后找回租约；前提是旧心跳尚未超时 |
| 心跳 | 终端每 2 s 调用一次 `lease_heartbeat(leaseId)`。附带有效 `leaseId` 的任何工具调用也算一次心跳 |
| 超时 | 服务器常量 `LEASE_TIMEOUT_MS = 10000`，**不可由客户端设置**。超过 10 s 未收到心跳，自动释放 |
| 主动释放 | `lease_release(leaseId)`，终端正常退出或用户点击“释放”时调用 |
| 强制释放 | `lease_force_release(hardwareId, reason)`，任何已认证客户端都可以调用；终端界面必须二次确认；服务器写日志并记录原持有者 |
| 释放的副作用 | **租约以任何方式结束（主动、超时、强制），服务器都执行 `safe_state`。** 规则只有一条，没有例外 |
| 查询 | `lease_status(hardwareId)` → `{held, holder?, acquiredAt?, lastHeartbeatAt?}`；`/device` 之外的运行态信息也包含它 |
| 无租约可用的工具 | `read`、`safe` 以及数据面订阅 |

【现状】终端侧已按本节实现（`B\devices\leases.py`：终端级持有、后端心跳、丢失即中止运行、手动 configure/actuate 同样经过租约；操作 `streams.leaseRelease` / `streams.leaseForceRelease`，事件 `lease`）。

#### 4.5.2 终端侧行为

1. **按需获取。** 第一次需要 `configure`/`actuate`（测试运行开始，或用户在设备页手动操作）时获取，之后一直持有，直到终端退出或用户释放。
2. **心跳由 Python 后端发出**，而不是渲染进程，每个持有的租约一个定时任务。后端崩溃，心跳自然停止，10 s 后服务器释放并回到安全状态。
3. **终端内部互斥。** 同一终端的多次运行共享一个租约，由后端的设备级互斥锁保证同一台设备同一时刻只有一个运行在做 `configure`/`actuate`。只读操作不受影响。
4. **丢失租约。**

   | 情形 | 行为 |
   |---|---|
   | 心跳返回 `busy` 或“未知租约” | 视为丢失 |
   | 连续 10 s 心跳失败 | 视为丢失 |

   丢失后：
   - 正在使用该设备的运行立即**中止**，未完成的判定记为 Inconclusive（原因 `lease_lost`），已派发但结果未知的动作进入核销列表；
   - 终端可以在下次需要时重新获取租约，但**绝不自动恢复**被中止的运行。
5. **退出顺序。** 用户关闭终端时：
   1. 中止运行中的测试并执行其 cleanup 区域；
   2. 对所有持有的租约调用 `lease_release`，服务器随即执行 `safe_state`；
   3. 退出进程。

   任何一步失败都不阻塞退出，心跳超时兜底。
6. **界面。** 设备管理页显示每台设备的租约状态：空闲、本终端持有、被 `<user>@<host>` 持有，并提供“释放”和“强制释放”按钮。

#### 4.5.3 为什么仍需要超时

“没有时间限制”指的是业务上不需要续期、不会到期。只要终端开着就一直占有。但服务器无法区分“终端还在，只是没发消息”和“终端已经崩溃”，所以心跳丢失超时（10 s）必须存在，它是租约自动取消的唯一机制。

### 4.6 设备生命周期与安全

- 状态机：

  ```
  initializing → open → closing → closed
  initializing → unreachable（打开失败）
  open → faulted（运行中出错）
  ```

  只有 `open` 状态接受 `configure`/`actuate`/`read`。

- 看门狗：`unreachable` 时按 5 s、10 s、30 s 退避重开，重开成功后先执行 `safe_state`，再进入 `open`。
- `safe_state` 执行时机：
  - 启动时，设备打开后；
  - 进程退出前（`/admin/shutdown`、`hardwareharness_prepare_shutdown`、信号）；
  - 租约结束；
  - `safe` 类工具被调用。
- 适配器必须实现 `safe_state()`，把所有输出置于无害值：AO 为 0 V、DO 为低、继电器断开、波形停止、电源输出关闭。`--check` 在模拟驱动上验证这一点。
- 所有驱动调用都在 `io_lock`（RLock）下串行执行。
- dry-run：`server.json` 的 `dryRun: true`，或 `select_driver(real, simulated)` 选到模拟驱动时，`/device.identity.dryRun` 为 `true`，终端必须在界面上醒目标示。

### 4.7 `server.json` 与凭据

```jsonc
{
  "serverId": "PCI1710L_MCP", "hardwareId": "PC1_MCP.PCI1710L_CARD_0",
  "manufacturer": "Advantech", "model": "PCI-1710L",
  "host": "0.0.0.0", "port": 8011,
  "token": "<随机 32 字节 base64url>",
  "computerId": "REMOTE_PC_1",
  "dryRun": false,
  "settings": { … }            // 适配器自定义配置，例如设备号、COM 口
}
```

- 【目标】`server.json` 由终端在首次安装时生成，令牌由终端随机生成，保存在终端的密钥存储中（`mcp:<serverId>`）。以后重装时沿用已有配置；README 中“由人工在远端维护”的说法作废。
- **禁止**把 `server.json` 或任何令牌、密码提交到仓库，也禁止从远端拉回到仓库目录。
- 终端的密钥存储条目：`ssh:<computerId>` 保存 SSH 密码或私钥，`mcp:<serverId>` 保存 `{token}`。
- 【目标】密钥存储由工作站服务自己通过 Python `keyring` 访问系统凭据库（Windows 上是“凭据管理器”），服务名固定为 `HardwareHarness`。这样服务不经过界面也能取到令牌。
- 【现状】密钥用 Electron `safeStorage` 加密，后端经 stdio JSON-RPC 回调主进程读写（`host/rpc.py`）。迁移时由服务一次性把旧条目导入系统凭据库，之后删除回调。

### 4.8 部署与服务管理【目标：统一由终端提供】

> **DEC-07：部署、启动、停止、日志、发现都由终端后端统一提供，界面和 Agent 调用同一套操作。** `mcp_servers/deploy.ps1` 与 `tools/remote-source.cjs` 退役；维护者使用的命令行改为调用后端同一套代码（`python -m hardwareharness_backend.devices.deploy …`）。

#### 4.8.1 远端目录与服务注册表

```
C:\ProgramData\HardwareHarness\services.json      ← 本机已安装服务的注册表，由 install.ps1 写入
E:\<id>_mcp_server\                               ← 每个服务一个根目录（remoteRoot）
    server.json  build.json
    venv\  wheels\  app\
    install.ps1  start.ps1  stop.ps1  status.ps1  runner.ps1  uninstall.ps1
    run\server.pid
    logs\server.out.log  logs\server.err.log
    backup\<时间戳>\
```

`services.json`：

```jsonc
{"formatVersion": 1,
 "services": [{"serverId": "PCI1710L_MCP", "hardwareId": "PC1_MCP.PCI1710L_CARD_0",
               "adapter": "hh_adapter_pci1710l", "adapterVersion": "0.3.0",
               "root": "E:\\pci1710l_mcp_server", "port": 8011,
               "installedAt": "2026-09-30T10:00:00+08:00"}]}
```

- 注册表**不含令牌**。
- `install.ps1` 与 `uninstall.ps1` 负责增删条目。

#### 4.8.2 生命周期命令由约定产生

服务的启停命令不再需要用户填写，全部由 `root` 推导：

| 操作 | 命令 |
|---|---|
| 状态 | `& '<root>\status.ps1'`，输出 `{state, pid, listening, message}` |
| 启动 | `& '<root>\start.ps1'`：`Win32_Process.Create` 启动 `runner.ps1`，写 pid 文件，等待端口监听 |
| 停止 | 先通过 MCP 调用 `hardwareharness_prepare_shutdown`，再执行 `& '<root>\stop.ps1'`：POST `/admin/shutdown`，等待 30 s 后强制结束 |
| 强制停止 | `stop.ps1 -Force`，需要能力 `devices.forceStopServers` |
| 日志 | `Get-Content -Tail N '<root>\logs\*.log'`，N ≤ 2000 |

- 服务器配置中的 `lifecycle` 字段改为**可选的覆盖项**，只在非标准安装（例如 FireDAP、本机服务）时填写。
- 开机自启：可以在安装时注册计划任务，在开机时运行 `start.ps1`。安装选项 `autostart`，默认开启。
- 不引入 Windows 服务包装器（WinSW/NSSM），以减少依赖。

#### 4.8.3 终端提供的操作

| 操作 | 说明 |
|---|---|
| **添加电脑** | 输入地址、SSH 用户名和密码（或私钥），记录主机密钥指纹。连接后读取 `services.json`，列出该电脑上已安装的服务，勾选即可导入 |
| **添加已有服务**（只知道 URL） | 输入 `http://<host>:<port>` 和令牌 → GET `/health` → GET `/device` → 生成服务记录和设备注册项。无 SSH 时只能使用、不能启停，界面显示“未托管” |
| **部署新服务** | 选择电脑、适配器、端口、设备配置 → 本地打包（SDK + 适配器 + 离线 wheel + 脚本 + `build.json`）→ 生成或沿用 `server.json` 和令牌 → 进入部署流程 |
| **升级 / 重新部署** | 同一套部署流程，沿用远端现有的 `server.json` |
| **启动 / 停止 / 重启 / 强制停止** | 见第 4.8.2 节 |
| **查看日志** | 同上 |
| **卸载** | 安全停止 → 运行 `uninstall.ps1` → 删除注册表条目；目录备份后删除 |

部署流程（沿用现有 `deploy.ps1` 的保障，禁止省略其中任何一步）：

```
打包 → 上传到 staging → 校验 SHA-256 → 备份现有版本 → 安全停止旧服务
→ 替换文件 → install.ps1（venv + 离线 wheel）→ 远端 --check 合规检查
→ start.ps1 → 轮询 /health 直到 healthy → GET /device 刷新注册表
→ 任一步失败：恢复备份并重新启动旧版本
```

- 所有操作使用 paramiko（`B\devices\ssh.py`），PowerShell 命令以 `-EncodedCommand` 执行。
- Agent 通过网关工具 `deploy_remote_mcp_service` 等调用这些操作，与界面走同一代码路径，并受能力控制（第 8.4 节）。

---

## 5. 数据面

### 5.1 目标

数据面回答“设备上发生了什么、什么时候发生的”。它必须满足：

1. **完整性可知**：消费者总能知道自己有没有漏数据、漏了哪一段。
2. **时间可信**：每条记录都有服务器时间戳，并能换算到终端时间，同时给出误差范围。
3. **可断线续传**：网络闪断后从断点接着收，不重复、不遗漏。
4. **可判定“没有发生”**：通过水位线确认某时间段内的数据已经全部送达。
5. **动作可关联**：动作期间产生的记录带有 `operationId`。
6. **按需工作**：没有订阅者时，轮询类设备不做采样。

### 5.2 流模型

一台设备有若干条**流**，每条流是一串按 `seq` 递增的**记录**。所有记录都有公共字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `seq` | 整数 | 从 0 开始，每条 +1，单个 epoch 内严格递增、无空洞（被覆盖的部分通过 `gap` 报告） |
| `t` | 浮点 | 服务器时间，Unix 毫秒（第 5.8 节） |
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

【目标】流声明（`/device.streams[]`）增加以下字段：

| 字段 | 适用类型 | 含义 |
|---|---|---|
| `unit` | scalar、block | 物理单位，例如 `V`、`A`、`Hz` |
| `width` | bits | 位数 |
| `bitLabels` | bits | 可选，每位的名称 |
| `rateHz` | 轮询类流 | 采样频率 |
| `writable` | bytes、frames | 是否可以通过 `_transact`/发送工具写入 |
| `idScheme` | frames | 身份编码方案，见第 5.4 节 |
| `label` | 全部 | 显示名 |
| `kind` | 全部 | `measured`（测得值）或 `setpoint`（设定值影子），用于显示和证据分级 |

### 5.3 服务器内部结构

```
驱动回调线程 ──publish()/rx()──┐
                               ▼
Sampler（有需求时按 rateHz 轮询 sample()，在 io_lock 下执行）──► RingBuffer（每条流一个，容量 4096 条）
                               ▲                                 │
工具调用（ContextVar 带 op）───┘                                 ├─► SSE 订阅者 A（终端 hub）
                                                                 ├─► SSE 订阅者 B（curl 调试）
                                                                 └─► <prefix>_stream_read（MCP 分页读取）
```

- **环形缓冲**：每条流一个，默认容量 4096 条（bytes/frames 同时有字节上限）。写满后覆盖最旧记录。`publish` 线程安全，可以在厂商回调线程中直接调用。
- **Sampler**：只在至少有一个 SSE 订阅者或活跃读取时运行（需求计数），频率 0.1～200 Hz。一个 Sampler 可以同时服务多条流（扫描组，例如 1710L 的 16 路 AI 一次读出）。
- **操作标记**：工具执行期间，`operation.CURRENT`（ContextVar）指向当前动作。`asyncio.to_thread` 会复制上下文，所以驱动线程中追加的记录也带 `op`；SDK 自己创建的后台线程不带。
- **blob**：内容存在独立的 LRU 中（默认最多 64 个、32 MB），记录里只放 `ref`。内容通过 `<prefix>_blob_read(ref)` 读取。

### 5.4 frames 的 `id` 编码约定

`frames.id` 是一个整数。各总线必须按下表把身份字段编码进去，并在流声明的 `idScheme` 中注明：

| `idScheme` | 编码 | 说明 |
|---|---|---|
| `can` | CAN ID；扩展帧加 `1 << 31` | 与 SocketCAN 的 EFF 标志一致 |
| `a429` | `sdi << 8 \| label`；`data` 为完整 32 位字（小端 4 字节） | label 取线上的原始 8 位值，显示时转换为八进制 |
| `m1553` | 命令字（`RT << 11 \| TR << 10 \| SA << 5 \| WC`）；`data` 为数据字（每字 2 字节，小端）；状态字放在 `note` 中，或者作为 `dir: "rx"` 的第二条记录 | 模式码按命令字原样编码 |
| `ieee1394` | `channel << 16 \| msgType`（AS5643 消息 ID） | 异步包使用 `1 << 31 \| tcode << 16 \| 源节点` |
| `raw` | 适配器自定义，必须在工具描述中说明 | 最后手段 |

### 5.5 SSE 协议

#### 5.5.1 请求

```
GET /streams/{streamId}?from=<seq|latest>&since=<ms>
Authorization: Bearer <token>
Accept: text/event-stream
Last-Event-ID: <epoch>:<seq>          （可选，重连时由客户端带上）
```

起点优先级：`Last-Event-ID` > `since` > `from`，默认 `from=latest`。

| 参数 | 含义 |
|---|---|
| `from=<seq>` | 从这个序号开始；已被覆盖则先发 `gap` |
| `from=latest` | 只要新记录；对电平型流，先发当前生效的那一条 |
| `since=<ms>` | 从服务器时间 `ms` 开始。电平型流从“该时刻仍然有效的记录”开始，所以窗口起点的值总是已知 |
| `Last-Event-ID: e:s` | 从序号 `s` 续传。`e` 不等于当前 epoch 时，发 `gap{reason: reset}` 后从头开始 |

未知的流返回 404。

#### 5.5.2 事件

| 事件 | `id` | `data` | 发送时机 |
|---|---|---|---|
| `hello` | — | `{streamId, streamType, epoch, fromSeq, serverTime}` | 连接建立后第一条 |
| `batch` | `<epoch>:<下一个 seq>` | `{records: [...], watermark}` | 每 50 ms 把新记录打包发送，每批最多 500 条 |
| `gap` | — | `{fromSeq, toSeq, reason: overflow\|reset}` | 请求的记录已被覆盖（overflow），或服务重启（reset） |
| `status` | — | `{state, sampling, errors, lastError?, watermark}` | 状态变化时，且至少每 200 ms 一次；推进水位线 |
| `status`（`state: closed`） | — | 同上 | 服务关闭前最后一条 |

- `epoch`：服务每次启动时随机生成。
- `state` 取值：`live`、`degraded`、`stopped`、`closed`。
- `sampling`：轮询类流当前是否在采样。

#### 5.5.3 水位线

> **watermark 承诺：所有 `t ≤ watermark` 的记录都已经在本连接上发出，或者已经以 `gap` 报告。**

- 对轮询类流，水位线等于最近一次采样的时刻（即使值没有变化）。
- 对事件类流（bytes、frames），水位线等于驱动最近一次确认“到此为止没有更多数据”的时刻，通常是读线程最近一次读取返回的时刻。
- 驱动出错或停止采样时，水位线**停止推进**。消费者因此等不到水位线，最终判为 Inconclusive（`watermark_timeout`），而不是误判为“没有发生”。
- 适配器如果无法给出这个承诺（例如厂商 SDK 只在有数据时回调），必须定期（≤ 200 ms）调用一次空读，或者用 `status` 把 `state` 标为 `degraded`，并在工具描述中说明。

#### 5.5.4 背压与丢失

- 服务器不为慢消费者无限缓存。订阅者落后超过环形缓冲容量时，被覆盖的部分以 `gap{overflow}` 报告，然后从最旧的仍存在的记录继续。
- 终端 hub 应及时消费（它只做追加写入，不做计算），正常情况下不会产生 overflow。

### 5.6 波形输出【目标】

> **DEC-06：波形由离硬件最近的一方生成。终端只下发波形参数或一整段采样点，禁止逐点经网络推送波形。**

原因：网络与操作系统调度的抖动是毫秒级的，逐点推送的波形会严重变形；而且断网时输出会停在某个随机值上。

#### 5.6.1 能力声明

`capabilities.waveform`（每个支持的通道一项，或者统一声明）：

```jsonc
{"waveform": {
   "channels": [1, 2, 3, 4, 5, 6, 7, 8],
   "mode": "software",               // hardware：板卡或仪器按硬件时钟输出；software：服务器进程定时写入
   "shapes": ["sine", "square", "triangle", "sawtooth", "dc"],
   "maxUpdateHz": 200,               // software 模式的写入频率上限
   "maxSampleRateHz": null,          // hardware 模式的采样率上限
   "maxArbitrarySamples": 4096,
   "timingAccuracy": "±5 ms jitter"  // 给判定使用的时序精度说明
}}
```

#### 5.6.2 工具

| 工具 | kind | 参数 |
|---|---|---|
| `<prefix>_set_waveform` | actuate | `channel, shape, frequencyHz, amplitude, offset, dutyCycle?, phaseDeg?, startAt?`（服务器时间，可选，用于多通道同步起始） |
| `<prefix>_load_arbitrary` | configure | `channel, samples[]`（或 `blobRef`）、`sampleRateHz, repeat: true\|count` |
| `<prefix>_start_waveform` | actuate | `channel`（用于 `load_arbitrary` 之后） |
| `<prefix>_stop_waveform` | actuate | `channel, holdValue?`（默认回到 `offset` 或 0 V） |

- `set_waveform` 调用成功即开始输出。结果信封的 `data` 返回实际生效的参数（例如频率被量化后的值）。
- 服务器同时把**设定值影子**发布到一条 `kind: setpoint` 的 scalar 流：software 模式下发布每个写入值；hardware 模式下只发布参数变化事件。运行台据此显示“应该输出什么”，但判定输出是否正确时，必须使用独立测量（例如 AI 通道）。
- `safe_state` 必须停止所有波形。
- software 模式的波形在服务器进程内由专门的线程生成，使用单调时钟做相位累加，不累积漂移；每次写入仍在 `io_lock` 下执行。

#### 5.6.3 慢速步进与复杂剖面

| 需求 | 做法 |
|---|---|
| 慢速扫描（每点停留 ≥ 100 ms，例如 0～10 V 每 0.5 V 一步） | 计划中使用 `ForEach` + `InvokeTool(set_voltage)` + `Observe`，每一步都有独立的锚点和判定 |
| 较快的分段剖面（例如 50 ms 一段的阶梯、斜坡） | 【可选】`<prefix>_run_profile(channel, segments[{durationMs, from, to, shape}], repeat)`，由服务器执行 |
| 高频或精密波形 | 必须使用 hardware 模式的设备：带 FIFO 的 DA 卡、AWG、信号源 |

**现有设备**：PCI-6208V 只有静态 DA，只能提供 `mode: software`、`maxUpdateHz ≤ 200` 的低频波形。另外，台架上该卡的 ±15 V 供电故障，输出始终约为 0 V（硬件问题，见团队记录）。

### 5.7 数据面不做什么

- **不做反应式控制。** 终端观察到某条记录后再下发动作，延迟为数十毫秒且不确定。需要“收到 X 立即回 Y”的场景（例如模拟 1553B RT 应答、周期报文调度），必须在资源服务器内实现为**场景工具**，例如 `<prefix>_start_rt_simulation(config)`，由服务器甚至板卡固件完成。
- **不做 DUT 协议解码**（见第 2.3 节）。
- **不做判定。** SDK 中残留的判定或比较逻辑应删除（第 12 章）。

### 5.8 时间与时钟

- **服务器时钟**：`clock.now_ms()` = 启动时读取一次的墙钟 + `perf_counter` 流逝量。单调、不倒退，单位为 Unix 毫秒（浮点）。
- 流记录的 `t`、信封的 `timing`、SSE 的 `watermark` 和 `serverTime`，全部使用这个时钟。
- **终端对时**：终端对每个服务器周期性（持有流时每 1 s）请求 `/time`：
  - 偏移 = `serverTime − (send + recv) / 2`；
  - 不确定度 = RTT / 2；
  - 在最近 16 个样本中，取不确定度最小的一个。
  - `hello` 事件也提供一个样本【现状】。
- **跨服务器换算**：服务器 A 的时间 `tA` 换算到服务器 B 的时间为 `tA − offsetA + offsetB`，不确定度为 `uA + uB`。
- **精度边界**：局域网中不确定度通常 < 2 ms。判定窗口的边界精度不高于该不确定度。窗口宽度与不确定度之比过小时，判为 Inconclusive（`clock_uncertainty`）。

### 5.9 终端侧：hub、录制、实时显示

#### 5.9.1 hub

- 每个（服务器，流）只建立**一条** SSE 上游连接，由多个消费者共享：运行中的判定、录制器、运行台显示。
- hub 给每条记录增加 `tb`（终端接收时间），并把 `gap` 转换为时间区间 `{t0, t1}`。
- 断线后以 0.2 s 到 5 s 的指数退避重连，并带上 `Last-Event-ID`。
- 未知流（404）报告 `unknown_stream`。
- 以上均为【现状】，见 `B\streams\source.py`。

#### 5.9.2 录制器

- 每次测试运行一个 SQLite 文件：`runs/<runId>/streams.sqlite`，WAL 模式。
- 表：
  - `meta`；
  - `streams(key, type, clock, count, watermark, watermarkTb, maxSpan)`；
  - `records(i, key, seq, t, tEnd, tb, op, data)`；
  - `gaps`、`states`、`blobs`。
- 运行开始前预录 1000 ms，结束后补录 500 ms。
- 录制的是**原始记录**。协议层派生的字段不单独存储，需要时由 ICD 重新计算（第 6.4 节）。
- 以上均为【现状】，见 `B\streams\recorder.py`、`store.py`。
- 【现状】流记录与运行日志已合并进同一个文件 `runs/<runId>/run.sqlite`（第 9.5 节），流表结构不变，只是多了日志表；旧运行目录中的 `streams.sqlite` 只读可用。

#### 5.9.3 实时显示

- 【目标】渲染进程订阅 SSE `GET /api/live?keys=<k1,k2>&width=<像素宽>&window=<ms>`：
  - 服务端从 hub 取数，按屏幕像素宽做 min/max 抽稀（每个像素列给出最小值和最大值），曲线形状不失真，传输量与采样率无关；
  - 每 50 ms 推一帧增量，帧里带各流的水位线和 `gap` 区间；
  - 断线后带 `Last-Event-ID` 续传；关闭连接即结束订阅，不需要会话回收。
- 回看已录制的数据走普通操作 `streams.window(runId, keys, t0, t1, width)`，同样返回 min/max 抽稀结果。
- 这样终端内外都是 SSE：资源服务器到 hub 是 SSE，hub 到界面也是 SSE。
- 【现状】渲染进程通过 `streams.read(sessionId, key, {t0, t1, maxPoints, after, limit, waitMs})` 长轮询，经 `POST /api/invoke` 调用；`waitMs` 最长 30 s，每次最多 20000 点；会话闲置 60 s 后回收（`B\application\streams.py`）。迁移到 `/api/live` 后删除。

### 5.10 调试接口

`<prefix>_stream_read(streamId, fromSeq?, limit=200)` 通过 MCP 分页读取记录，供 Agent 或无 SSE 客户端的场景使用。它不影响 SSE 订阅者。

---

## 6. 被测产品协议层（ICD 解码层）【目标】

### 6.1 位置与职责

- 位于终端后端 `hardwareharness_backend/protocol/`，处在 hub 与判定、显示之间（第 2.3 节图）。
- 输入：原始 `bytes`/`frames` 流。
- 输出：**派生字段流**。
- 与被测产品一一对应：换产品只换 ICD 文件，不改资源服务器，也不改平台代码。

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
- 1553B、429 可以按 `id` 匹配，结合第 5.4 节的编码。
- CAN 应直接使用 **DBC 文件**（`icd/*.dbc`），由 cantools 解码，不再重复定义。
- 复杂的变长结构可以使用 Kaitai Struct（`.ksy`），作为扩展格式。

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
- 终端按 ICD 组帧、计算校验，再调用资源服务器的发送工具（`<prefix>_transact` 或 `<prefix>_send`）。
- 服务器看到的仍然只是字节。

---

## 7. 测试语义

### 7.1 计划结构【现状】

```jsonc
{"schemaVersion": 2,
 "parameters": { … },            // 输入参数及其 schema
 "requirements": [ … ],          // 需要的设备与工具
 "bindings": { … },              // 【目标】逻辑名 → 实际设备（第 7.6 节）
 "protocolBindings": [ … ],      // 【目标】第 6.4 节
 "stopOnFail": true,
 "regions": {"prepare": [ … ], "test": [ … ], "cleanup": [ … ]}}
```

- `cleanup` 区域在正常结束、失败、中止时都会执行。
- 计划先编译再执行。编译会解析工具绑定（`bindingRevision = schema 哈希`），工具 schema 变化时，编译会报告需要重新绑定。

### 7.2 步骤目录

| 步骤 | 关键参数 | 输出 `steps.<id>.*` | 状态 |
|---|---|---|---|
| `Sequence` / `Group` | children | — | 现状 |
| `Parallel` | children | — | 现状 |
| `If` | condition, elseChildren | — | 现状 |
| `Repeat` | count | — | 现状 |
| `ForEach` | itemsExpression；子步骤中可以使用 `item`、`index` | — | 现状 |
| `Retry` | attempts 1～20, delayMs | — | 现状；**禁止包住未知结果的 actuate**，由编译检查 |
| `SetVariable` | variable, valueExpression | — | 现状 |
| `Evaluate` | expression | value | 现状 |
| `Delay` | durationMs | — | 现状 |
| `InvokeTool` | hardwareId（或绑定名）, toolName, arguments, timeoutMs=30000, errorPolicy, anchor, assertions, `encode`【目标】 | result, timing, streamRefs | 现状 |
| `Observe` | hardwareId, streamId, window{anchor, startMs, endMs}, assertions, minSamples=3 | 统计量、verdict | 现状 |
| `Expect` | hardwareId, streamId, anchor, offsetMs, withinMs, match, `capture`【目标】 | verdict, matchT, latencyMs, record, `captures`【目标】 | 现状 |
| `Guard` | hardwareId, streamId, condition, onViolation abort\|fail；包住子步骤 | verdict, 违规记录 | 现状 |
| `ManualCheck` | prompt, images?, options（默认 通过/不通过/无法判断）, requireNote, timeoutMs? | verdict, note, operator, t | **目标** |
| `PublishResult` | value / valueExpression, unit, metadata, verdict | — | 现状 |

断言运算符：`lt le gt ge eq ne within outside matches contains`，容差可以是绝对值或百分比。

### 7.3 表达式

- 语言为 CEL 的安全子集，基于 Python AST 实现：
  - 【现状】支持 `&& || !`、比较（含链式）、`in`、四则运算与取模、属性和索引访问、列表和字典字面量。
  - 上下文：`parameters`、`variables`、`steps`、`item`、`index`。
- 【目标】增加以下能力（纯函数，无副作用）：

  | 类别 | 内容 |
  |---|---|
  | 数值 | `abs`、`min`、`max`、`round(x, n)`、`floor`、`ceil`、`sqrt` |
  | 转换 | `int(x)`、`int(s, base)`、`float`、`str`、`hex(x)` |
  | 集合 | `len`、`sum`、`all`、`any`、`sorted` |
  | 位运算 | `& \| ^ << >> ~`，以及 `bit(x, n)`、`bits(x, lo, hi)` |
  | 字节 | `bytes_hex(s)`、`u16le(b, off)` 等少量取值函数（复杂的解析应放进 ICD） |
  | 字符串 | `startsWith`、`endsWith`、`contains`、`matches`、`split`、`trim` |

- 禁止：I/O、时间函数、随机数、任意属性反射。表达式必须能在编译期完成类型检查。

### 7.4 Observe 的统计量

- 【现状】按流类型提供，见 `B\streams\judge.py`。
- 【目标】对 scalar/block 增加波形指标：

  | 指标 | 说明 |
  |---|---|
  | `rms`、`pp`（峰峰值） | — |
  | `freq`、`period`、`duty` | 基于过零或迟滞比较，需要参数 `threshold` 与 `hysteresis` |
  | `riseMs`、`fallMs` | 10%～90%，精度受采样率限制，报告中注明 |
  | `settleMs` | 进入容差带并保持的时刻 |

- 【目标】跨流指标（新增步骤 `Compare` 或 Observe 的 `reference` 参数）：两条流之间的相位差、延迟（互相关）、比值。两条流来自不同服务器时，自动附带时钟不确定度。

### 7.5 Expect 捕获【目标】

- `capture` 从命中的记录中提取值，保存到 `steps.<id>.captures.<name>`：

  ```yaml
  capture:
    version: {regex: "VER=(\\S+)", group: 1}     # bytes：对 text 做正则
    code:    {field: "fields.code"}              # 派生流：取字段
    raw:     {field: "data"}
  ```

- 后续步骤可以用 `steps.<id>.captures.version` 做断言或计算，替代“读缓存找字段”的做法（A-01、A-02、D-01）。

### 7.6 绑定表（多工位复用）【目标】

- 计划中使用逻辑名，例如 `psu_main`、`dut_uart`，通过 `bindings` 映射到实际的 `hardwareId` 和流：

  ```yaml
  bindings:
    psu_main: {hardwareId: PC1_MCP.IT6952A_0}
    dut_uart: {hardwareId: PC1_MCP.CP118U_I_CARD_0, streamId: "serial${station}"}
  ```

- 批量运行（`start_test_batch`）为每个工位提供一组绑定值，例如 `station: 1..8`。这一机制覆盖项目 C 的“8 工位轮询”。
- 编译时展开绑定并校验：设备存在、工具存在、流存在。

### 7.7 判定与证据

- 判定结果：`pass`、`fail`、`inconclusive`。

  | Inconclusive 原因 | 含义 |
  |---|---|
  | `watermark_timeout` | 水位线在限定时间内没有越过窗口末尾 |
  | `gap` | 窗口内有数据缺口 |
  | `insufficient_evidence` | 样本数不足 |
  | `clock_uncertainty` | 对时误差相对窗口过大 |
  | `lease_lost` | 执行中丢失租约（【现状】） |
  | `operator_undecided` | 【目标】人工判定选择“无法判断”或超时 |

- 窗口锚点来自服务器 `timing.end`（与流记录同一时钟），跨服务器时按第 5.8 节换算。
- 判定时，终端等待水位线越过 `窗口末尾 + 不确定度`，最长等待 `max(2 s, 窗口宽度)`。
- 证据分级（写入每条判定结果的 `evidenceType`）：

  | 级别 | 内容 |
  |---|---|
  | T1 | 独立测量：采集卡、仪器直接测 DUT |
  | T2 | 仪器自测：电源 `MEAS:VOLT?` |
  | T3 | 仪器内部的精密测量结果，例如示波器测得的上升时间 |
  | P | DUT 协议回报 |
  | M | 人工判定 |
  | S | 设定值影子，**只能用于显示，不能作为判定证据**，编译时拒绝 |

- 所有判定保存窗口参数、样本引用（`key` + `seq` 范围）和结果。报告可以离线重新判定。

### 7.8 未知结果与核销【现状】

- `actuate` 调用超时、连接中断或返回 `invalid_response` 时，结果为**未知**。
- 该调用进入恢复列表，运行暂停或按策略中止。
- 由人或 Agent 调用 `reconcile_test_operation`，并附上依据（例如观察到的流数据），把结果确认为已执行或未执行。
- **禁止自动重发。**

---

## 8. AI Agent 设计

### 8.1 组成

- 使用 OpenCode 作为 Agent 外壳，连接本地的 OpenAI 兼容模型服务。
- 终端后端的 `mcp_gateway` 在 `127.0.0.1` 上提供 MCP 服务：
  - 只接受回环地址的连接，并校验 Host、Origin 和 Bearer 令牌；
  - 请求体上限 1 MB。
  - 以上为【现状】。
- 【目标】网关是操作注册表的一个接入适配器（第 9.3 节）：内置工具由注册表生成，不再单独声明；权限、确认、审计与界面走同一条中间件路径。
- 技能文档 `skill/mcp-server/` 教 Agent 编写适配器：流程、契约、SDK API、模板、检查脚本。技能文档必须与本文第 4、5 章保持一致。

### 8.2 工作模式与工具配置【目标】

本地模型能力有限，工具过多会导致选错工具。网关按**模式**提供工具子集：

| 模式 | 典型任务 | 提供的工具 |
|---|---|---|
| `adapter` | 编写或调试适配器 | 设备声明读取、远程服务管理（部署、启停、日志）、单个目标服务器的设备工具 |
| `plan` | 编写测试计划 / ICD | 项目、设备注册表、`get_hardware_definition`、步骤目录、计划的校验和编辑、ICD 校验和试解码、流观察 |
| `run` | 运行、分析、核销 | 运行控制、结果和事件读取、`testing_read_run_io`、恢复与核销 |
| `explore` | 手动调试设备 | 目标设备的工具（按需展开）、`observe_stream`、`expect_stream` |

- 【现状】所有远程设备工具都平铺在工具列表中，名称为 `<serverId>__<tool>`。
- 【目标】各模式包含哪些内置工具，由操作注册表中每个操作的 `profiles` 字段决定，不在网关中另写清单。
- 【目标】默认不平铺。提供 `list_device_tools(hardwareId)` 和 `enable_device_tools(hardwareId)`，由 Agent 按需展开单台设备的工具；`run` 模式中不展开设备工具，动作只能通过计划执行。

### 8.3 声明读取

- Agent 通过网关的 `get_hardware_definition(hardwareId)` 读取设备声明。其内容来自终端注册表中缓存的 `/device`，包括引脚和流清单；图片以资源 URI 提供，模型支持图像时可以读取。
- Agent 不直接访问资源服务器的 HTTP 接口。

### 8.4 安全边界

| 规则 | 实现 |
|---|---|
| 能力控制 | 每个网关工具绑定一项能力，例如 `hardware.executeTools`、`devices.forceStopServers`、`devices.deploy`。用户在设置中授权 |
| 高风险操作确认 | 部署、强制停止、强制释放租约、核销，需要在界面上确认（除非用户明确授权自动执行） |
| 参数安全范围 | 适配器在工具内做范围检查，例如电压上限；终端不得绕过 |
| 未知结果 | Agent 不能重发，只能核销（第 7.8 节） |
| 适配完成门槛 | 适配器状态从“开发中”到“可用”，必须满足三点：`--check` 通过、模拟器测试通过、有一条**人工实物冒烟记录**（执行人、时间、接线、观察结果） |

---

## 9. 终端软件架构

本章规定测试终端（工作站服务 + 桌面界面）的内部结构。第 4～8 章规定的是“做什么”，本章规定“代码怎么组织”。

### 9.1 总体形态【目标】

```
┌──────────── 工作站服务（Python，一个进程，可脱离界面运行）────────────┐
│ 接入层：HTTP API │ Agent MCP 网关                                    │
│            ▲ 两者都由同一个操作注册表生成（第 9.3 节）               │
│ 应用层：设备清单 · 服务运维 · 租约 · 计划 · 运行 · 报告 · ICD         │
│ 领域层：计划 IR · 编译器 · 解释器 · 判定器 · 表达式 · 协议解码        │
│ 资源层：MCP 连接池 · 流 hub + 对时 · SSH · 运行存储 · 系统凭据库      │
└──────────────────────────────────────────────────────────────────┘
      ▲ HTTP + SSE（127.0.0.1）                ▲ MCP（127.0.0.1）
 Electron 界面（只负责显示）               OpenCode Agent
```

- 工作站服务是终端的全部业务逻辑，**不依赖界面**。两种使用方式：
  - 桌面应用：Electron 启动服务，界面通过 HTTP + SSE 访问；
  - 浏览器（可选）：服务把构建好的前端作为静态资源提供，供同一台电脑之外的只读查看。默认只监听 `127.0.0.1`，对外监听必须在设置中显式开启，并且仍校验令牌。
- Electron 界面只负责显示和原生能力，不包含业务规则（第 9.6 节）。
- 【现状】服务由 Electron 主进程启动，stdout 一行握手后界面通过 HTTP + SSE 访问（`B\host\__main__.py`、`http_api.py`）。

### 9.2 分层与模块

| 层 | 职责 | 可以依赖 | 现有包（`B\…`） |
|---|---|---|---|
| 接入层 | 把注册表中的操作暴露为 HTTP、MCP；鉴权、编解码 | 应用层、注册表 | `host`、`mcp_gateway` |
| 应用层 | 用例：设备清单、服务运维、租约、计划、运行、报告、ICD、项目与接线 | 领域层、资源层 | `application`、`devices`、`projects`、`wiring`、`testing\application.py`、`testing\store.py` |
| 领域层 | 纯逻辑：计划 IR、编译器、解释器、判定器、表达式、协议解码。不做 I/O | 无（只依赖标准库和 Pydantic） | `testing\compiler.py`、`engine.py`、`expression.py`、`models.py`、`streams\judge.py` |
| 资源层 | 外部连接和持久化：MCP 客户端、流 hub、对时、SSH、运行存储、凭据库 | 无业务依赖 | `devices\mcp_client.py`、`ssh.py`、`streams\source.py`、`clock.py`、`recorder.py`、`storage` |
| 契约 | 各层共用的数据模型和错误码 | 无 | `contracts` |

- 依赖只能自上而下；领域层不得导入资源层。用 import-linter 在 CI 中检查（前端已用 dependency-cruiser 做同样的检查）。
- 领域层中的解释器通过接口调用资源（“发一个 MCP 调用”“读某条流的窗口”“追加一条日志”），接口的实现由应用层注入。模拟测试时注入假实现，不需要网络。

### 9.3 操作注册表【目标】

终端对外的每个操作（给界面、给 Agent）只在一处定义：

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
    confirm=False,                 # 是否需要界面确认
)
async def start_run(ctx: OpContext, req: StartRunRequest) -> RunRef: ...
```

- 参数和返回值都用 Pydantic 模型，**按字段名传参**。注册表是一个普通的字典，按名称索引，启动时一次性收集，不在调用时反射查找。
- 由注册表生成：

  | 目标 | 形式 |
  |---|---|
  | HTTP | `POST /api/ops/{name}`，请求体就是请求模型的 JSON；只读操作额外允许 `GET` |
  | OpenAPI | `GET /api/openapi.json`；构建时从它生成前端的 TS 类型和调用客户端（`openapi-typescript`），生成文件提交到仓库，CI 检查是否过期 |
  | MCP 工具 | 名称把 `.` 换成 `_`（`runs_start`）；`inputSchema` 取自请求模型；`annotations` 由 `risk` 推出（`readOnlyHint`、`destructiveHint`、`idempotentHint`）；按 `profiles` 分到各工作模式 |

- 中间件对所有入口一致生效，顺序固定：
  1. 解析和校验请求模型，失败返回 `invalid_argument`；
  2. 检查能力（调用方是界面用户或 Agent，各自有授权集合）；
  3. `confirm=True` 且调用方是 Agent 时，挂起并请求界面确认；
  4. 幂等：带 `requestId` 的请求先查请求账本，已完成的直接返回原结果；
  5. 执行；
  6. 写审计日志（调用方、操作、参数摘要、结果、耗时），敏感字段按模型上的标记脱敏；
  7. 对 `risk="actuate"` 的操作，如果结果未知（超时、断线），返回 `unknown_outcome`，**任何入口都不自动重试**（第 7.8 节）。
- 设备工具（`<serverId>__<tool>`）不在注册表中：它们来自远程服务器的 `tools/list`，由网关按需展开（第 8.2 节），但调用时同样经过第 2、3、6、7 步。
- 【现状】
  - `contracts\operations.py` 的 `@operation(capability)` 只做授权；`application\__init__.py` 的 `DESKTOP_METHODS` 把 `namespace.camelMethod` 映射到方法；
  - `host\runtime.py` 的 `invoke_operation(name, args: list)` 在调用时反射查找方法，参数是按位置排列的数组，并含 `wiring.updateDocument` 的特例；
  - 网关工具在 `mcp_gateway\tool_registry.py` 中用 `Tool` 数据类另写一遍（`BUILTIN_TOOLS`），前端 TS 类型手工维护。
  - 迁移时逐个操作改写为注册表形式，旧的 `/api/invoke` 在全部迁完之前保留。

### 9.4 前后端通信【目标】

| 通道 | 用途 |
|---|---|
| 主进程 ← 服务 stdout，**一行** | 启动握手：服务就绪后打印 `{"port": …, "token": "…", "version": "…"}`，之后 stdio 不再承载任何协议，只作为日志输出 |
| 渲染进程 → 服务，HTTP | `POST /api/ops/{name}`，JSON 请求体，Bearer 令牌；用生成的 TS 客户端调用 |
| 服务 → 渲染进程，SSE | `GET /api/events`：领域事件（设备、服务、租约、计划、运行、项目文件变化），带 `id`，支持 `Last-Event-ID` 续传 |
| 服务 → 渲染进程，SSE | `GET /api/live?keys=…&width=…`：实时曲线数据，服务端抽稀（第 5.9.3 节） |
| 渲染进程 ↔ 主进程，Electron IPC | 仅限：文件和目录对话框、窗口控制、自动更新、把握手得到的地址和令牌交给预加载脚本 |

- 主进程和服务之间没有回调通道。密钥由服务自己访问系统凭据库（第 4.7 节）。
- 服务退出时主进程显示错误并提供“重启服务”；主进程退出时通过关闭 stdin 通知服务退出，服务在退出前让所有持有的租约回到安全状态（第 4.5 节）。
- 事件只表示“某资源变了”，带资源键和新版本号，不携带完整数据；界面据此让相应查询失效后重新读取（第 9.6 节）。这样事件丢失时只需全量刷新，不会出现不一致。
- 【现状】
  - 主进程 ↔ 后端走 stdio JSON-RPC：`backend.initialize` 返回 API 地址和令牌，safeStorage 加解密通过 `call_host` 回调主进程（`host\rpc.py`），状态经 `desktop.event` 通知；
  - 渲染进程调用 `POST /api/invoke {operation, args}`，使用带类型标记的编解码（`host\codec.py`）；
  - `GET /api/events` 已支持续传；
  - 实时数据走 `streams.read` 长轮询。

### 9.5 运行日志与运行存储【目标】

每次运行的全部事实按时间顺序追加进**运行日志**，日志是唯一记录：

```
run.started(planHash, stationBinding, operator)
  step.entered(stepId, attempt)
    tool.dispatched(opId, target, tool, args)
    tool.completed(opId, result) │ tool.unknown(opId, reason)
    verdict(stepId, checkId, pass|fail|error, evidence{streamKey, t0, t1})
  step.exited(stepId, outcome)
  lease.acquired / lease.lost / safe_state.applied
  reconciled(opId, decision, by)
run.ended(outcome)
```

- 每条日志有递增序号和终端时间 `tb`；`opId` 在发出调用**之前**写入 `tool.dispatched`，调用返回后写 `tool.completed`。
- 所有其他信息都从日志推导，不另存可变状态：

  | 需要的信息 | 推导方式 |
  |---|---|
  | 运行状态、当前步骤、进度 | 从头折叠日志 |
  | 崩溃恢复 | 重新打开日志并折叠；最后一步未结束则按第 7.8 节处理 |
  | 待核销列表 | 有 `tool.dispatched`、没有 `tool.completed` 且没有 `reconciled` 的调用 |
  | 报告 | 由日志和计划生成，可随时重新生成 |
  | 重新判定 | 取 `verdict` 中的证据区间，对录制的原始数据重跑判定器，结果作为新的判定版本，不改原日志 |

- 存储：`runs/<runId>/run.sqlite`，WAL 模式，包含日志表 `journal(seq, tb, kind, stepId, opId, body)`、计划快照、绑定表快照，以及第 5.9.2 节的流记录表。**一个文件就是一次运行的完整证据包**，可以拷走、归档、离线重判。
- 引擎拆成三块：
  - **编译器**：计划 YAML + 绑定表 → 计划 IR（纯函数，领域层）；
  - **解释器**：按 IR 执行，只通过接口发调用、读流、写日志（领域层）；
  - **日志存储**：追加写入、折叠、查询（资源层）。
- 项目文件（计划、ICD、接线、工位绑定表）是项目目录下的 YAML 文本，可以用 git 比较和评审，也方便 Agent 直接编辑。服务负责校验、建索引，并在文件变化时发事件。运行开始时把用到的文件快照进 `run.sqlite`，之后修改项目文件不影响已有运行。
- 【现状】
  - 引擎已拆为 `testing\compiler.py`、`interpreter.py`（只经端口调用设备、读流、写日志，测试注入假实现）和 `journal.py`；
  - 每次运行一个 `runs\<runId>un.sqlite`（WAL）：`journal`、`results`、`snapshots`（plan、wiring、summary）以及流表；不再写 `run.log`；
  - 旧布局（`events.jsonl`、`results.jsonl`、`plan.hhplan.yaml`、`wiring.json`、`summary.json`、`streams.sqlite`）只读可用，不转换；
  - 【目标】跨运行的操作账本、运行索引、请求和接线任务仍在项目级 `.hardwareharnessuntime.sqlite3`（作为索引）；恢复和待核销列表尚未完全由日志折叠推导。

### 9.6 前端

#### 9.6.1 Electron 主进程

- 只做四件事：启动工作站服务并完成握手、管理窗口、原生对话框、自动更新。
- 预加载脚本只暴露：API 地址和令牌、对话框、窗口控制、更新状态。不暴露 Node 能力，渲染进程开启 `contextIsolation` 和 `sandbox`。
- 【现状】主进程还负责 OpenCode 进程的启停和认证（`D\main\opencode-*.ts`、`agent-integration.ts`）。【待定】是否移入工作站服务，使浏览器方式也能使用 Agent。

#### 9.6.2 页面

| 页面 | 内容 | 数据来源 |
|---|---|---|
| 设备与服务 | 电脑、服务、设备列表；外观图、端口图、引脚表；服务状态、租约、日志；部署、启停、添加 | 设备注册表（缓存的 `/device`）；运行态来自 `/health` 和 `lease_status` |
| 台架接线 | 设备卡片、端口、连线；接线任务；工位绑定表 | `/device.pinout` 与端口图、接线 YAML |
| 计划 | 步骤树、参数、绑定、ICD；表单视图和 YAML 视图 | 步骤目录、设备工具 schema |
| 运行台 | 左侧步骤树和判定结果；右侧曲线（uPlot）、串口终端视图（xterm.js）、报文表（原始和解码两栏） | `/api/events`、`/api/live`、运行日志、协议层派生流 |
| Agent | OpenCode 会话；待确认的高风险操作 | 网关 |

#### 9.6.3 状态管理

- 服务端数据全部由 TanStack Query 管理，查询键与操作名对应（例如 `["runs.get", {runId}]`）。前端不另存一份后端数据。
- 维护一张“事件 → 失效查询键”的映射表，`/api/events` 收到事件后按表让查询失效。新增事件类型必须同时更新映射表，由测试检查覆盖。
- 前端本地状态只有界面状态（选中项、面板布局、未保存的表单草稿）。
- 【现状】已使用 TanStack Query（`D\renderer\lib\queries.ts`、`query-keys.ts`、`mutations.ts`），类型手工维护；事件到失效的对应集中在 `lib\hooks\useHardwareHarnessEvents.ts`，其中 `project` 事件携带完整文档并直接写缓存，另有 15 s 兜底轮询。

#### 9.6.4 计划编辑器

- 步骤表单根据步骤类型的 JSON Schema 自动生成（复用 `features\manual\SchemaForm.tsx`），新增步骤类型不需要改前端。
- 同时提供 YAML 文本视图（Monaco），用同一份 schema 做补全和校验。两个视图编辑的是同一份文档。

### 9.7 设备注册表【目标调整】

- **受管设备**（有服务器）：定义以 `/device` 为准，本地只缓存，保存在 `devices/hardware/<id>/`，并记录 `manifestRevision`。
  - 用户不能编辑引脚和图片，可以编辑本地别名和备注。
  - 删除 `set_hardware_image`、`save_hardware_definition` 对受管设备的写入能力。
- **无源设备**（转接箱、线缆、DUT 本身，没有服务器）：继续由用户或 Agent 在终端中定义，保留现有的 `formatVersion 2` 格式和 `.hhhw` 包。
- 服务器离线时使用缓存显示，并标注“离线，显示的是缓存版本”。

### 9.8 测试

- 不做虚拟台架（DEC-18）。各适配器的模拟驱动（`select_driver(real, simulated)`）只用于适配器自己的单元测试，输入读空闲值，不在服务之间回送接线。
- 桌面应用的端到端测试（Playwright）使用 `e2e/fixtures/hardware-mcp.ts` 中的假 MCP 服务器。
- 实物台架用于冒烟测试和适配器放行（第 8.4 节“适配完成门槛”）。
- 测试分层：
  - 领域层：纯单元测试，不需要网络；
  - 应用层 + 接入层：对注册表中每个操作做契约测试（请求模型、错误码、能力检查），并检查 OpenAPI 与生成的 TS 类型没有过期；
  - 端到端：假 MCP 服务器 + 桌面应用；实物冒烟：实物台架 + 桌面应用。

---

## 10. 覆盖范围

依据 `doc/research/` 中四个历史项目，合并后约 65 个测试项（A-01～A-13、B-01～B-05、C-01～C-10、D-01～D-38，其中部分为保留或非测试项）。

| 阶段 | 能力 | 可覆盖的测试项 |
|---|---|---|
| 现状 | 设备工具 + Observe/Expect/Guard（正则匹配文本）+ 独立测量 | 约 23 项：纯电气测量、开关、文本应答类 |
| + 协议层（第 6 章）+ 捕获（第 7.5 节）+ 表达式函数和位运算（第 7.3 节） | 二进制协议字段判定、版本读取、1394/429/1553 报文 | 约 62 项 |
| + 波形指标与跨流比较（第 7.4 节）+ 人工判定（第 7.2 节） | 周期、相位（D-37）；视频画面（C-10） | 64～65 项 |
| 不覆盖 | 需要服务器端场景工具的连续联动（B-05 类反应逻辑），另行实现场景工具 | — |

| 测试资源类别 | 接入方式 | 状态 |
|---|---|---|
| 采集卡、DA 卡、DIO 卡、继电器卡 | 厂商 DLL + ctypes 适配器 | 已有 4 个（1710L、1762、6208V、CP118U-I） |
| SCPI 仪器（电源、负载、万用表） | VISA/串口适配器 | 待编写，最易由 AI 生成 |
| 自定义协议模块（调理板、ZT DA/TTL） | 串口适配器 + 适配器内组帧 | 待编写 |
| 总线卡（1553B、429、1394、CAN） | 厂商 DLL 适配器 + frames 流 + 场景工具 | 待编写，难度最高 |
| 视频 | 矩阵适配器 + ManualCheck；自动画质判定不在范围内 | 待编写 |

---

## 11. 决策记录

| 编号 | 决策 | 理由 | 备选及否决原因 |
|---|---|---|---|
| DEC-01 | 声明走 HTTP，动作走 MCP，数据走 SSE | 每类信息只有一个来源；声明可以缓存和校验，并直接服务界面 | 全部走 MCP 工具：界面也得调用 MCP，图片不便传输，AI 和界面看到的内容可能不一致 |
| DEC-02 | 一台设备一个服务进程 | 故障隔离，独立升级 | 一台电脑一个进程：驱动崩溃会连带影响其他设备 |
| DEC-03 | 数据面使用 SSE 而不是 WebSocket | 单向即可；自带续传；可以用 curl 调试 | WebSocket：需要自己实现续传和心跳；消息队列：需要额外部署组件 |
| DEC-04 | 判定只在终端 | 跨设备判定、可重新判定、调试与正式运行一致 | 服务器端判定：只能看到单台设备，会导致两套判定逻辑 |
| DEC-05 | 租约持续占有、靠心跳维持，持有者是终端实例，任何方式结束都执行 safe_state | 实现最简单；终端退出后自动释放；失联即安全 | 带 TTL 并需续期：多一套续期逻辑；每次运行获取：运行之间设备可能被别人抢走 |
| DEC-06 | 波形由服务器或硬件生成 | 网络抖动会使逐点推送的波形变形；断网时输出失控 | 终端逐点推流：时间精度不可接受 |
| DEC-07 | 部署和管理统一由终端后端提供 | 界面、Agent、维护者共用一套代码；添加已有服务更简单 | 保留 PowerShell 加 Node 脚本：两套实现，界面无法使用 |
| DEC-08 | DUT 协议解码在终端，ICD 是数据 | 资源服务器与产品无关；换产品只换 ICD；可以重新解码 | 写在适配器里：适配器与产品耦合；写在计划表达式里：难以维护、容易出错 |
| DEC-09 | 校验算法只能从命名表选择 | 避免 AI 手写 CRC 出错；可以用 check 值测试 | 允许自定义代码：无法保证正确 |
| DEC-10 | 反应式逻辑放在服务器端的场景工具 | 延迟和确定性要求超出终端能力 | 在计划中写“观察后动作”：延迟数十毫秒且不确定 |
| DEC-11 | 未知结果只核销，不重发 | 物理动作可能已经发生 | 自动重试：可能重复执行动作 |
| DEC-12 | 适配器完成需要人工实物冒烟测试 | 模拟器无法证明接线、驱动与实物一致 | 只靠模拟器：可能把实物上不工作的适配器标为完成 |
| DEC-13 | 后端是可独立运行的工作站服务，Electron 只负责显示 | 业务规则只放一处；服务不依赖界面，可以单独测试 | 业务逻辑放在 Electron 主进程：无界面时无法运行，Python 与 TS 各写一半 |
| DEC-14 | 一个操作注册表生成 HTTP、MCP 和 TS 类型 | 入口越多，权限、审计、校验越容易漏写；手写类型在重构中反复不一致 | 反射 + 位置参数 + 手写类型（现状）：改名和调整参数时无法静态发现错误；tRPC：只覆盖 TS 一侧，Python 后端和 MCP 仍需另写 |
| DEC-15 | 运行日志是一次运行的唯一记录，状态由日志推导 | 恢复、核销、报告、重判需要的都是“发生过什么”；可变状态与日志并存时两者会不一致 | 日志 + 可变状态表 + 结果文件分开存（现状）：恢复时要把几处拼起来 |
| DEC-16 | 前后端只用 HTTP + SSE；stdio 只做一行启动握手 | 通道越少，一个功能涉及的代码位置越少；SSE 可直接用 curl 调试，与资源服务器一致 | stdio JSON-RPC 双向回调（现状）：主进程成为必经中转；WebSocket：需要自定义心跳和重连，而 SSE 自带续传 |
| DEC-17 | 密钥存进系统凭据库（Python `keyring`） | 服务无界面时也要读取令牌；删除主进程回调 | Electron `safeStorage`（现状）：只能由主进程解密；明文文件：不安全 |
| DEC-18 | 不做虚拟台架；端到端测试用假 MCP 服务器，实物台架做冒烟（2026-10-01 修订） | 只有一个台架、一个小团队，虚拟台架没有使用者；它要维护进程管理、接线配置和注册流程，成本高于收益 | 虚拟台架（2026-09-30 版本）：能走真实 SDK，但实现后无人使用 |

---

## 12. 代码对齐清单

路径前缀：
- `SDK` = `mcp_servers/sdk/src/hardwareharness_device_sdk`
- `B` = `HardwareHarness/python/src/hardwareharness_backend`
- `D` = `HardwareHarness/apps/desktop/src`

### 12.1 资源服务器 SDK

| 编号 | 对应章节 | 现状 | 修改 | 位置 |
|---|---|---|---|---|
| S1 | 4.3 | 没有 `/device`、`/assets` | 新增两个路由；由类属性、`pinout()`、`capability_details()`、流注册表和 `assets/` 自动生成；计算 `manifestRevision`；`/health` 增加该字段 | `SDK/app.py` |
| S2 | 4.3 | `Connector` 没有图片字段；设备没有外观图 | `Connector.image`（asset、mediaType、pinPositions）；`Device.appearance_image` 或约定 `assets/appearance.*` | `SDK/pinout.py`、`SDK/device.py` |
| S3 | 4.3.3 | 存在 `get_pinout`、`list_streams` 工具；`capability_details.pinoutSource/listTool` | 删除这两个工具及相应字段 | `SDK/app.py` |
| S4 | 5.2 | `describe()` 只返回 `{id, type}` | 增加 `unit/width/bitLabels/rateHz/writable/idScheme/label/kind`，由构造参数提供 | `SDK/streams.py` |
| S5 | 4.5 | TTL 200～600000 ms，需要 `lease_renew`，到期由清扫器执行 safe_all；释放不改变输出 | 删除 TTL 参数；`lease_heartbeat`；固定 `LEASE_TIMEOUT_MS=10000`；同一持有者重复获取幂等；`lease_force_release`；任何方式结束都执行 `safe_state`；带有效 `leaseId` 的调用视为心跳 | `SDK/lease.py`、`SDK/app.py` |
| S6 | 5.6 | 没有波形能力 | 提供 `capabilities.waveform` 的声明辅助；提供 software 模式的波形生成器（单调时钟相位累加，在 `io_lock` 下写入）；在 `safe_state` 中停止波形 | `SDK/`（新建 `waveform.py`） |
| S7 | 5.7 | SDK 可能残留判定或比较逻辑 | 检查并删除（判定只在终端） | `SDK/` 全局 |
| S8 | 5.5.3 | 事件类流的水位线语义没有写入契约 | 在 `ByteStream`/`FrameStream` 中提供 `idle(t)` 方法，用于推进水位线；`--check` 检查读线程是否定期推进 | `SDK/streams.py`、`SDK/sse.py` |
| S9 | 4.4.4 | `CONTRACT_REVISION = "2026-09-24.1"` | 合入以上改动时升级版本号 | `SDK/envelope.py` 或定义处 |
| S10 | 8.1 | 技能文档描述旧契约 | 同步 `references/contract.md`、SDK API 文档和模板 | `skill/mcp-server/` |

### 12.2 适配器

| 编号 | 修改 |
|---|---|
| A1 | 四个适配器增加 `assets/`：外观图、端口图；在 `pinout.py` 中引用 |
| A2 | 流声明补充 `unit`（1710L 的 AI 为 V，6208V 的 AO 为 V）、`width`（DI/DO/relay）、`kind`（6208V 的 AO 为 `setpoint`） |
| A3 | pci6208v：新增 `set_waveform`/`stop_waveform`（software 模式，`maxUpdateHz ≤ 200`）；`safe_state` 停止波形 |
| A4 | cp118u_i：读线程每次读取返回后推进水位线（S8） |

### 12.3 部署

| 编号 | 现状 | 修改 |
|---|---|---|
| R1 | `mcp_servers/deploy.ps1` + `tools/remote-source.cjs`（Node ssh2）+ `tools/assemble.py` | 把打包逻辑（`assemble.py`）迁入后端 `B/devices/deploy/`；远程步骤改用 paramiko；删除 Node 脚本；`deploy.ps1` 改为调用后端命令行的薄包装，或者删除 |
| R2 | 没有远端服务注册表 | `install.ps1` 写入 `C:\ProgramData\HardwareHarness\services.json`；新增 `uninstall.ps1` |
| R3 | README 说 `server.json` 由人工维护 | 改为由终端生成（4.7）；更新 `mcp_servers/README.md` |
| R4 | 无开机自启 | `install.ps1 -AutoStart` 注册计划任务 |
| R5 | `servers.json` 是部署清单 | 由终端注册表取代；文件保留到 R1 完成后删除 |

### 12.4 终端后端

| 编号 | 对应章节 | 现状 | 修改 | 位置 |
|---|---|---|---|---|
| B1 | 4.8.2 | `server_lifecycle_schema` 的四个命令字段必填 | 改为可选的覆盖项；默认由 `root` 推导 | `B/contracts/devices.py` |
| B2 | 4.8.3 | 只能添加完整配置的服务；必须先有电脑 | 新增“按 URL + 令牌添加”（未托管服务，`computerId` 可空）；新增“从电脑导入”（读取 `services.json`） | `B/devices/device_service.py`、`B/application/services.py` |
| B3 | 4.8.3 | 没有部署操作 | 新增 `deploy/upgrade/uninstall` 操作和网关工具 `deploy_remote_mcp_service` 等（能力 `devices.deploy`） | `B/devices/`、`B/application/tools.py` |
| B4 | 4.7 | 令牌由用户手工填写 | 部署时生成令牌，写入密钥存储和远端 `server.json` | 同上 |
| B5 | 9.7 | 受管设备的图片和定义由终端编辑；`get_pinout` 未被使用 | 连接或 `manifestRevision` 变化时拉取 `/device`，写入注册表缓存；受管设备只读；`/assets` 下载到本地资源目录，`hardwareharness-asset://` 协议继续使用 | `B/devices/device_store.py`、`device_service.py`、`B/application/services.py` |
| B6 | 4.5.2 | `LEASE_TTL_MS=15000`，每次运行获取和续期，持有者为 run_id；获取失败时无租约继续运行 | 改为终端级租约管理器：按需获取、2 s 心跳、终端退出时释放；运行只借用；设备级互斥锁；丢失即中止运行并记为 `lease_lost`；获取失败则**不运行** | `B/testing/run_io.py` → 新建 `B/devices/leases.py` |
| B7 | 4.5.2 | 手动 `call_tool` 不持有租约 | 手动 `configure`/`actuate` 走同一个租约管理器 | `B/application/services.py` |
| B8 | 6 | 没有协议层 | 新建 `B/protocol/`：ICD schema、切帧、校验算法表（含 check 值测试）、解码、组帧、派生流接入 hub/judge/live；CAN 接入 cantools | 新建 |
| B9 | 7.3 | 表达式不支持函数调用和位运算 | 按第 7.3 节增加函数和运算符，并提供编译期检查 | `B/testing/expression.py` |
| B10 | 7.5 | Expect 没有捕获功能 | 增加 `capture` 参数和 `captures` 输出 | `B/testing/catalog.py`、`B/streams/judge.py` |
| B11 | 7.2 | 没有人工判定步骤 | 增加 `ManualCheck` 步骤和事件，界面提供对话框 | `B/testing/`、`D/renderer/features/` |
| B12 | 7.6 | 没有工位绑定 | 增加计划 `bindings`、批量运行的工位参数、编译期展开 | `B/testing/models.py`、`compiler.py` |
| B13 | 7.4 | 没有波形指标和跨流比较 | 在 judge 中增加 `rms/pp/freq/period/duty/riseMs/fallMs/settleMs` 和跨流比较 | `B/streams/judge.py` |
| B14 | 7.7 | 证据分级没有落地 | 判定结果写入 `evidenceType`；编译时拒绝以 `setpoint` 流作为判定证据 | `B/streams/judge.py`、`B/testing/compiler.py` |
| B15 | 7.2 | `Retry` 可以包住 `actuate` | 编译检查：`Retry` 内的 `actuate` 调用结果未知时不得重试 | `B/testing/compiler.py`、`engine.py` |
| B16 | 8.2 | 远程设备工具平铺在列表中 | 工作模式与按需展开（`list_device_tools`/`enable_device_tools`） | `B/mcp_gateway/tool_registry.py` |
| B17 | 8.4 | 没有适配器完成状态 | 设备注册表中增加 `adapterStatus` 和冒烟记录 | `B/contracts/devices.py` |

### 12.5 桌面渲染进程

| 编号 | 修改 |
|---|---|
| U1 | 设备页：显示服务器提供的外观图、端口图、引脚表（只读）；显示 dry-run 与离线缓存标识 |
| U2 | 设备页：服务器编辑器去掉生命周期命令的必填项；新增“按 URL 添加”“从电脑导入”“部署”“卸载” |
| U3 | 设备页：租约状态、释放、强制释放（二次确认） |
| U4 | 运行台：报文表格（原始/解码两栏）、派生字段曲线、`ManualCheck` 对话框 |
| U5 | 计划编辑：绑定表、ICD 编辑与试解码 |

### 12.6 终端架构

| 编号 | 对应章节 | 现状 | 修改 | 位置 |
|---|---|---|---|---|
| T1 | 9.3 | `@operation(capability)` 只做授权；`DESKTOP_METHODS` 映射方法名 | 注册表：`@operation(name, capability, risk, profiles, idempotency, confirm)`；请求和响应用 Pydantic 模型；按字段名传参；中间件（校验、能力、确认、幂等、审计、未知结果不重试） | `B/contracts/operations.py`、`B/application/` |
| T2 | 9.3、9.4 | `POST /api/invoke {operation, args[]}`，调用时反射查找，位置参数，带类型标记的编解码；TS 类型手写 | 新增 `POST /api/ops/{name}` 和 `GET /api/openapi.json`；构建时生成 TS 类型和客户端，CI 检查是否过期；前端改用生成的客户端；全部迁完后删除 `/api/invoke`、`invoke_operation`、`DESKTOP_METHODS`、`host/codec.py` 的类型标记 | `B/host/http_api.py`、`runtime.py`、`codec.py`、`D/preload/transport.ts`、`D/renderer/lib/` |
| T3 | 8.1、8.2、9.3 | 网关内置工具用 `Tool` 数据类另写一遍（`BUILTIN_TOOLS`） | 内置工具由注册表生成；工作模式由 `profiles` 决定；设备工具的调用也经过注册表中间件 | `B/mcp_gateway/tool_registry.py`、`contract_tools.py` |
| T4 | 4.7、9.4 | 密钥由 Electron `safeStorage` 加密，后端经 stdio JSON-RPC 回调；`backend.initialize` 握手 | 改用 Python `keyring`；首次启动导入旧条目；启动握手改为 stdout 一行 `{port, token, version}`；删除 stdio JSON-RPC 和 `desktop.event` 通知 | `B/storage/secrets.py`、`B/host/rpc.py`、`__main__.py`、`D/main/python-bridge.ts`、`python-runtime.ts` |
| T5 | 9.5 | `events.jsonl`、`results.jsonl`、`.hardwareharness/runtime.sqlite3`、`streams.sqlite` 分开存放 | 合并为 `runs/<runId>/run.sqlite`（日志表 + 快照 + 流表）；运行状态、恢复、待核销列表、报告、重新判定都从日志推导；提供旧运行目录的只读导入 | `B/testing/engine.py`、`runtime_state.py`、`store.py`、`B/streams/recorder.py`、`store.py` |
| T6 | 9.2、9.5 | `engine.py` 约 1700 行，执行、状态、写文件混在一起 | 拆为编译器、解释器、日志存储；解释器只通过接口调用 MCP、读流、写日志；模拟测试注入假实现 | `B/testing/`（新建 `interpreter.py`、`journal.py`） |
| T7 | 5.9.3 | `streams.read` 长轮询，会话 60 s 回收 | SSE `GET /api/live`，服务端 min/max 抽稀；`streams.window` 用于回看；删除长轮询和会话回收 | `B/application/streams.py`、`B/streams/live.py`、`D/renderer/features/streams/` |
| T10 | 9.6 | 事件处理已集中在 `useHardwareHarnessEvents.ts`，但 `project` 事件携带完整文档并直接写缓存，另有 15 s 兜底轮询；计划编辑器按步骤类型手写表单 | 事件只带资源键和版本号，映射表改为声明式数据并加覆盖测试，删除兜底轮询；步骤表单由 JSON Schema 生成（复用 `SchemaForm`）+ Monaco YAML 视图；预加载脚本只保留第 9.6.1 节列出的能力 | `D/renderer/lib/hooks/useHardwareHarnessEvents.ts`、`query-keys.ts`、`D/renderer/features/testing/`、`D/preload/api.ts` |
| T11 | 9.2 | 后端没有分层检查 | 用 import-linter 在 CI 中检查第 9.2 节的依赖方向 | `HardwareHarness/python/pyproject.toml`、CI |

### 12.7 优先级

按依赖关系分阶段实施。第 1 阶段先把终端架构的骨架（注册表、握手和密钥）搭好，后面各阶段新增的操作直接写在注册表上，不再扩大旧入口：

| 阶段 | 内容 | 效果 |
|---|---|---|
| 第 1 阶段 | T1、T2（注册表与 TS 类型生成，逐个操作迁移）；T4（密钥与握手）；T11 | 前后端契约由生成保证；主进程与服务之间只剩握手 |
| 第 2 阶段 | S5、B6、B7（租约）与 T5、T6（运行日志、引擎拆分）一起做；S1～S4、A1、A2、B5、U1（设备声明） | 修正安全语义；运行只有一份记录；界面显示依据统一 |
| 第 3 阶段 | R1～R5、B1～B4、U2、U3（部署管理）；T3（网关由注册表生成）；T7（实时数据 SSE） | 在界面中管理局域网中的服务；界面、Agent 同一路径 |
| 第 4 阶段 | B8、B9、B10、B14、U4、U5（协议层与语义）；T10 | 覆盖率从约 23 项提升到约 62 项 |
| 第 5 阶段 | S6、A3、B13、B11、B12、B15、B16、B17 及其余项 | 波形、人工判定、多工位、Agent 模式 |
