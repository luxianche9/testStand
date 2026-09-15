# HH 发行版 Agent 接口优化方案

分析日期：2026-09-15。依据：当前工作区实现、2026-09-14 OpenCode可见会话与工具记录。本文保留原始审查设计；2026-09-15 已按用户授权实施，实际变更和验证见 implementation-report.md。用户明确排除模拟测试功能，本方案中相关产品能力已取消。未部署真实设备服务或执行硬件测试。

**目标：安装包加用户工程就足以完成支持范围内的任务。Agent需要知道的行为、限制、结果和恢复路径，必须能通过公开契约取到；不能依靠在开发机上阅读HH实现。**

当前最大问题是“能力存在、但公开接口不完整或说明不准确”。只加一句“不要读源码”，会把本来能靠源码自救的任务变成无法完成。应补齐产品接口，再用提示词规定取证顺序，并在不挂载开发仓库的发行环境验收。

## 1. 全量范围与当前版本差异

| 类别 | 当前静态预期公开工具数 | 说明 |
|---|---:|---|
| HH内置 | 34 | 工程、服务、硬件目录、接线、Python运行 |
| CP118U_I_MCP | 11 | 4个管理工具 + 7个串口工具 |
| PCI1710L_MCP | 9 | 4个管理工具 + 5个AI/DI/DO工具 |
| PCI6208V_MCP | 7 | 4个管理工具 + 3个AO工具 |
| PCI1762_MCP | 8 | 4个管理工具 + 4个继电器/DI工具 |
| FIREDAP_MCP | 14 | 固件资料、探针、烧录、SRAM与作业查询 |
| 合计 | **83** | 另有5个仅供内部关闭的工具，继续隐藏 |

统计按每个serverId的实际注册分支计算，没有把四份相似适配器源文件中的其他型号分支重复计数。实际发行版在线目录还取决于设备连接、授权与插件；本文未启动服务获取实时tools/list。

全量逐项清单见 [all-tools-review.md](E:/Project/hardwareHarness/reports/agent-interface-review-2026-09-15/all-tools-review.md)，每个工具都包含当前说明、建议说明、需要补齐的行为/参数/返回契约和源码位置；另有 [CSV](E:/Project/hardwareHarness/reports/agent-interface-review-2026-09-15/all-tools-review.csv) 与 [机器可读清单](E:/Project/hardwareHarness/reports/agent-interface-review-2026-09-15/inventory.json)。

与昨天会话相比，当前代码已使用 `.hardwareharness/scripts/*.py`，不再以 Web apps/workflows 为产品入口；内置占用申请工具也不在当前目录中。当前方案应围绕 availability/execution conflict，不能把旧租约接口重新当作前提。FireDAP仍有“Requires occupancy”的旧说明，应与当前实际策略一起修正。

## 2. 为什么它不断查看源码

| 历史动作 | Agent真正缺少的信息 | 发行版应该提供什么 |
|---|---|---|
| 搜索mock/simulate、翻SDK/测试目录 | 提示词要求了不存在的能力 | 删除模拟测试要求，不新增模拟入口或模拟能力开关；明确静态校验与真实运行 |
| 读`_transport.py`、worker、设备MCP实现 | call返回几层封装、错误怎么表达、工具名是什么 | 版本化SDK结果契约、真实示例、全链路契约测试 |
| 读接线service、catalog | portA到底要怎么拼，是否支持同口回环 | 可直接复用的endpointRef、端点schema、结构化冲突/不支持响应 |
| 读server.py、驱动源文件 | 量程枚举、通道索引、串口模式、返回字段 | 公开参数语义、设备capabilities、类型化输出和参考资料 |
| 读server.json/启动脚本 | 为什么固件路径被拒、如何让服务读到文件 | 受管固件导入/分发、服务有效配置摘要和可执行恢复信息 |
| 到磁盘找tool-output与运行日志 | 大输出被截断、Run终态和附件读不到 | 分页、摘要、稳定artifactId及公开读取工具 |
| 读应用模板和pyproject | 产品支持什么程序、环境怎么初始化 | 安装包内开发指南、可创建脚本、模板、环境状态 |

这些不是模型凭记忆能可靠补全的常识，而是产品契约。尤其“0基还是1基”“read_last是否实测”“read_rx是否消费缓存”必须由工具说明负责。

## 3. 发行前优先修复的确定缺口

### 3.1 MCP缺少创建第一个脚本的能力

公开目录只有`write_workspace_file`。当前`WorkspaceService.write`先`read(path)`核对hash，文件不存在会失败；空hash也不能创建。应用服务已有`create_file`，但没有对应MCP注册。

证据：[WorkspaceService.write/create](E:/Project/hardwareHarness/HardwareHarness/python/src/hardwareharness_backend/workspace/files.py:155)、[ApplicationsApplication.create_file](E:/Project/hardwareHarness/HardwareHarness/python/src/hardwareharness_backend/application/applications.py:148)。

**改造**：公开独占创建操作，例如`create_workspace_file`，复用现有service与路径规则。已有文件更新仍使用expectedHash。不要让一个写操作默默覆盖，也不要靠系统提示词教模型用shell绕过产品创建流程。

### 3.2 有随包指南，但MCP读不到

环境初始化会生成`.hardwareharness/docs/hardwareharness-sdk.md`；读取工具却调用只接受`scripts/*.py`的WorkspaceService.read。没有公开的文档查询入口。更严重的是指南只在文件不存在时写入，旧工程升级后可能一直保留旧说明。

证据：[指南生成](E:/Project/hardwareHarness/HardwareHarness/python/src/hardwareharness_backend/workspace/environment.py:67)、[脚本读取限制](E:/Project/hardwareHarness/HardwareHarness/python/src/hardwareharness_backend/workspace/files.py:106)。PyInstaller已收集workspace包内数据，因此不需要公开内部源码来解决；应在包内增加版本化参考资料，并用专用只读入口访问。

**改造**：`read_reference`读取已登记referenceId/章节；先有一个短索引，按需展开。指南带appVersion、sdkVersion、contractRevision和内容哈希。平台自带文档与用户笔记分开，升级不覆盖用户内容，也不把旧指南继续当成当前真相。

### 3.3 工具说明和schema在聚合途中丢失

- 34个内置工具：**0个outputSchema**；47个顶层输入参数：**0个字段description**。
- 49个设备工具：**39个公开注册函数没有description/docstring**。底层驱动函数即使有丰富docstring，经server包装函数注册后也不会自动成为公开工具说明。
- `mcp_client.py`读取并校验上游outputSchema，但存入可公开工具记录时没有保留它；annotations也没有保留。
- `ToolRegistry.list`对设备工具只输出name/inputSchema/description，模型看不到上游kind、结果语义或其他描述元数据。

证据：[上游工具摄取](E:/Project/hardwareHarness/HardwareHarness/python/src/hardwareharness_backend/devices/mcp_client.py:187)、[聚合输出](E:/Project/hardwareHarness/HardwareHarness/python/src/hardwareharness_backend/mcp_gateway/tool_registry.py:188)。

**改造**：不是简单透传所有字段。由于网关改变了工具名、hardwareId参数和结果封装，必须生成与**实际公开响应**匹配的schema。保留可支持的annotations、类型与契约引用；不支持的MCP task/execution能力不能原样宣称支持。元数据是说明，不是授权依据。

### 3.4 Agent与SDK返回形状不同，却没有清楚说明

当前Agent的聚合硬件工具通常得到：

```json
{"ok": true, "data": {"volts": 1.23}}
```

当前Python SDK走`preserveEnvelope=True`，同一个工具通常得到原始MCP envelope：

```json
{
  "content": [{"type": "text", "text": "..."}],
  "structuredContent": {"ok": true, "data": {"volts": 1.23}},
  "isError": false
}
```

以上是形状示例，不是真实测量。服务还可能有message/meta或媒体内容。现有指南只有“retain advertised result shape”，没有把两条链路讲清楚。现有测试确实验证preserveEnvelope保留，说明这不是可以随手删掉的偶然包装。

证据：[SDK调用链](E:/Project/hardwareHarness/HardwareHarness/python/src/hardwareharness_backend/application/applications.py:91)、[返回适配](E:/Project/hardwareHarness/HardwareHarness/python/src/hardwareharness_backend/devices/mcp_client.py:339)、[既有契约测试](E:/Project/hardwareHarness/HardwareHarness/python/tests/devices/test_sdk_envelope.py:10)。

**短期**：公开`agentResultSchema`与`sdkResultSchema`，每个工具给可运行示例，让新测试使用真实封装，而非只返回理想data。支持text-only/isError-only等失败路径，不只处理structuredContent.ok=false。

**推荐目标**：在新SDK契约版本统一业务结果读取，原始MCP envelope与媒体继续由运行日志/附件保留；旧项目锁定旧SDK并提供迁移示例。不能静默改变0.1.0项目返回值，也不能为了简单解包丢弃图片/资源。

### 3.5 文案和后端语义需要一起修

- `pci6208v_set_voltage`底层docstring说clamped，但实现越界拒绝；公开说明必须跟实现一致。
- `pci6208v_read_last`只是软件影子值；`safe_state`使用配置的safe_volts，不保证0V。
- CP118U `mode`是帧格式编码，不能被解释为RS232/RS485实体拨码。
- CP118U `read_rx`返回自上次clear以来的累计缓存；并不消费缓存。0超时空读成功，正超时空读报错，这个差异必须公开，最好统一为可诊断的idle结果。
- PCI1710L的`signal_type/value_range`目前只是整数参数，SE/Diff与量程枚举埋在实现里。
- 继电器DO回读不等于触点连通；16位mask也不能被宣称整卡原子切换。

这些信息要进入每个工具的一两段说明及参数schema，不应都塞进系统提示词。全部83项建议文字已在逐项清单中。

## 4. 建立一份可生成的工具契约

现在内置JSON、`_ARGUMENT_SCHEMAS`、Python函数签名、驱动校验、指南和提示词分别维护，容易漂移。建议把**接口契约作为唯一事实来源**：函数实现可手写，但schema、模型说明、文档与验证样例从共同类型/声明生成并被测试约束。

每个契约最少包含：

| 内容 | 要回答的问题 |
|---|---|
| 身份 | remoteName、externalName、SDK名称、所属server/hardware、版本 |
| 使用时机 | 何时用、前置条件、返回后下一步是什么 |
| 输入语义 | ID来自哪里；单位、索引起点、enum映射、默认、边界、可省略行为 |
| 输出语义 | 同步结果还是作业；结果字段类型/单位；是设定值、缓存值、驱动确认还是物理测量 |
| 副作用 | 是否激励/清空/复位/烧录，影响单通道还是全设备 |
| 状态与错误 | 输入拒绝、冲突、离线、部分成功、等待超时、结果未知如何区分 |
| 重复调用 | 哪些查询可重复；哪些动作不能重放；有无真正实现的幂等键 |
| 示例 | 一个真实形状成功例子、一个常见错误、对应SDK示例 |
| 资料 | 可解析referenceId、型号/修订版、来源页码，禁止开发机专用路径 |

字段语义应具体。`channel: integer`不够；应写“逻辑端口1–8，对应P1–P8，Windows COM映射见设备状态”。`volts: number`不够；应写“V、有限值、卡范围±10、负载额定另受限、越界拒绝”。

标记“readOnly/idempotent”也要逐项检查，而不是整类复制：清空缓存、重配置、复位和safe_state都会改变状态；测量值会随时间变，但重复查询不应被等同于重复激励。授权与并发限制仍由平台验证，不能信任第三方工具自报的只读标签。

## 5. 三层信息分发，避免上下文膨胀

**第一层：短运行时概况。** 启动/切工程/版本变化时给应用与SDK版本、程序模式、当前工程、环境、能力开关、文档索引及catalog revision。事实由程序生成。

**第二层：可直接调用的工具简明schema。** `tools/list`保留足够调用信息，说明约80–180中文字符作为编辑目标，关键数值放字段description。不能为了省token删掉调用必需参数。

**第三层：按需契约与资料。** 工具详细输出schema、典型错误、SDK例子、板卡完整针脚和资料页通过读取工具获取。长日志/截图/大JSON返回摘要与稳定引用。

当前OpenCode不应被假定自动支持延迟加载工具；先保留现有具名工具，缩短重复说明、分页大输出、消除重复发现内容。后续若验证客户端确实支持动态工具目录再减少默认暴露数量。不要先把83项都藏到一个`call_any_tool(name,args)`后面而失去类型和调用可见性。

当前Gateway只注册initialize/ping/tools/list/tools/call，未见resource读取链路。可以补MCP resources，但必须保留`read_reference`等工具入口，不能只新增一个当前客户端拿不到的资源库。

## 6. 应补齐的公开能力

下表名称是建议，**目前不存在的接口不能先写进可执行示例**。优先复用已存在的service，避免再造一套状态机。

| 优先级 | 建议入口 | 最小功能和范围 |
|---|---|---|
| P0 | `get_agent_context` | 运行时版本、工程、环境、功能开关、文档索引、有效执行策略；可并入get_project，但无工程时仍应可查 |
| P0 | `get_tool_contract` | 按公开toolName读取参数/结果/错误/SDK例子；返回contractRevision。搜索可用name/query受约束分支实现 |
| P0 | `read_reference` | 按referenceId/section/page或query读取随包/用户登记资料，给来源与续页；只读，不暴露后台任意文件 |
| P0 | `create_workspace_file` | 复用已有create_file，独占创建scripts/*.py；保留更新expectedHash语义 |
| P0 | 有效执行状态查询 | 按hardwareIds返回availability、busyReason、持有运行和观测时间；可扩充list_managed_hardware/get_agent_context，无须恢复旧租约 |
| P1 | `wait_for_status` | 对Run/接线/服务已有对象有界等待，传revision/cursor，返回changed/terminal，不重提动作；已有FireDAP wait保留 |
| P1 | 运行附件/源码读取 | 复用已有read_run_attachment/read_run_source；按runId+公开artifact引用访问，Agent无需猜内部日志目录 |
| P1 | 固件导入/暂存 | 将用户固件导入目标服务受管存储，校验hash/格式/大小，返回不可变artifactId或该服务接受的路径；不能靠改firmwareRoots |

“准备好执行吗”的preflight可以作为状态查询组合，但不能把一次preflight通过当永久许可；实际操作仍必须在执行点验证冲突与设备状态。

## 7. 所有六个SDK接口的文档补齐

| 接口 | 必须说明的内容 |
|---|---|
| `call(hardware_id, tool_name, arguments, *, timeout_ms=None)` | SDK工具名不是OpenCode带客户端前缀的名字；设备须声明；当前返回原始envelope；超时可能结果未知，不重放 |
| `acall(...)` | 与call相同结果/错误；async不保证同一设备可并发；不要并发发互相冲突的配置/写入 |
| `step(name)` | 装饰器、同步/异步上下文；每个并发调用用独立step；步骤状态不代表业务测试判定 |
| `log(message, *, level='info', fields=None)` | level允许值、JSON字段、自动source/run关联、日志脱敏与大小限制；禁止将凭据记录成fields |
| `measurement(name, value, *, unit=None)` | 数值类型及有限值、单位约定；区分commanded与measured命名，记录测量不自动产生pass/fail |
| `attachment(path, *, name=None, media_type=None)` | 运行进程可访问路径、复制而非外链、大小/类型限制、附件保留与读取方式；复制成功后才可删除临时文件 |

发行资料覆盖无硬件调用的普通计算程序和含 finally 清理的最小硬件流程。每套都显示启动→查终态→业务判定/附件；硬件名称由runtime绑定，不能写开发机固定hardwareId。

开发者契约测试使用受控测试替身验证 SDK、工具参数与响应适配。这不构成产品模拟模式；普通 Python 程序仍是可信项目代码，不宣称 OS 沙箱。

## 8. 接线、设备资料与实验事实

端口引用当前由`hardwareId + '.' + portId`形成，而portId本身可能已经含硬件前缀。应对新契约返回不可自行推导的`endpointRef`，或使用`{hardwareId, portId}`结构化端点；为旧引用提供明确兼容层。不要教模型按点拆字符串。

接线响应应区分：

- `requested`：待办已创建。
- `confirmed`：人工确认当前线序。
- `persisted`：项目文档保存。
- `verified`：有对应实验/测量证据的连通结论。

这些是建议语义，不要求马上把所有枚举名塞进同一个状态字段。状态属于不同对象，应分别保存版本/时间/证据引用。重启后待办可丢失，已保存连接不能因此判成空白，更不能自动重建成曾经失败的接线方案。

板卡资料至少记录型号、硬件revision、连接器视图方向、针号、信号方向、参考地、允许电压/模式、共享网络、跳帽要求及来源。原理图网络名不能代替实际收发方向核对。读资料也不能冒充已看过实物。

`firedap_get_board_reference`目前把被动DUT资料绑定在烧录器服务上。建议资料能力独立到硬件目录/reference库，让不使用FireDAP的项目也能查同一DUT。相同事实只维护一份，驱动引用版本化资料。

## 9. 错误必须能引导恢复，不能只返回一句字符串

当前错误在不同层会被压成`device_error`或只有category/message；模型只能翻实现找原因。建议对常见错误保留结构化事实，例如：

```json
{
  "ok": false,
  "error": {
    "category": "invalid_argument",
    "field": "portA",
    "code": "endpoint_not_found",
    "message": "端点引用不存在",
    "operationStarted": false,
    "outcomeKnown": true,
    "recovery": {
      "tool": "get_hardware_definition",
      "arguments": {"hardwareId": "<actual-id>"},
      "instruction": "从返回的规范端点引用选择，不自行拼接"
    }
  }
}
```

这是目标响应示例。recovery里的工具名/参数必须由当前目录验证，不能变成新的幻觉来源。

`retryable=true`不能单独指导重做物理动作。必须知道动作是否提交、结果是否可确定、重复会否产生副作用。服务重启、烧录、串口发送等超时首先查询原operationId/jobId，只有明确未执行或满足已实现幂等条件才考虑重试。

对于纯资料/作业状态查询，当前`DevicesApplication.call_tool`统一获取manual执行句柄，可能与活跃Run冲突。需要按可信契约拆分管理查询和动作锁，使诊断时能查询既有作业；同时保持真正硬件采样/写入的协调规则。

## 10. 系统提示词应承担什么

当前核心指令位于[gateway.py](E:/Project/hardwareHarness/HardwareHarness/python/src/hardwareharness_backend/mcp_gateway/gateway.py:33)，通过MCP initialize的server instructions发送；[openCodeConfig](E:/Project/hardwareHarness/HardwareHarness/apps/desktop/src/main/opencode-runtime.ts:48)配置模型和MCP，未在这段配置中见到显式HH Agent prompt。

不能假设server instructions一定以预期权重进入模型上下文。应在捆绑OpenCode版本上验证实际消费，并让稳定规则通过其受支持的Agent/system入口注入，MCP instructions保留精简服务协议。两处文本从同一声明生成，避免分别维护。

建议分工：系统指令放工作边界、证据标准和流程；工具description放操作契约；runtime context放版本与能力；reference放完整资料；项目状态放用户目标、接线与已验证事实。

完整草案见[system-prompt-draft.md](E:/Project/hardwareHarness/reports/agent-interface-review-2026-09-15/system-prompt-draft.md)。关键变化包括：

- 平台信息优先来自公开接口；不依赖HH内部源码，但允许用户项目源码和厂商手册。
- 不猜隐藏模拟开关、工具名、SDK方法和旧版目录。
- 删除“先模拟”及模拟测试入口要求；程序保存后先做语法/静态校验，再按授权执行。
- 不把软件设定、寄存器回读、局部回环、程序正常退出夸大成完整物理验收。
- 使用现有ID等待、处理未知结果、不自动重放动作。
- 不增加已授权普通工作的重复确认；需要实物信息时只问具体缺失事实。

## 11. 推进顺序与影响范围

| 批次 | 交付 | 主要修改位置 | 验收重点 |
|---|---|---|---|
| P0-A | 83项工具契约与说明完整，元数据正确公开 | `tool_registry.py`、两个tool JSON、`mcp_client.py`、五类server.py | 真实tools/list而非仅源码检查；字段/输出/例子一致 |
| P0-B | 空工程可创建脚本、可读当前指南、能查SDK返回形状 | 已有ApplicationsApplication/WorkspaceService、reference读取、环境manifest | 干净安装包内从零创建并运行一个程序 |
| P0-C | 当前执行状态与提示词版本对齐 | context生成、availability查询、删除模拟要求、OpenCode注入 | 不再沿旧租约或不存在能力的猜测流程 |
| P1-A | 规范端点、按需资料、可恢复错误、紧凑日志/附件 | catalog、wiring、gateway error、run store facade | 无源码下完成接线与失败诊断 |
| P1-B | 固件受管导入、异步等待/不重放 | firmware staging、run/service/job状态适配 | 无需改服务器配置，超时提交次数不增加 |
| P2 | SDK结果版本迁移、工具按需发现优化 | SDK、worker、生成文档和兼容测试 | 不破坏旧项目、不丢媒体，客户端确认支持后再减少工具暴露 |

第一步不需要推倒全部工具，也不需要先做复杂的智能诊断Agent。先消除模型必须读源码才能得知的事实，再看历史回放中的调用数和任务成功率。

## 12. 如何证明优化有效

完整方案见[release-evaluation.md](E:/Project/hardwareHarness/reports/agent-interface-review-2026-09-15/release-evaluation.md)。重点是用真实安装包和干净用户环境，运行历史中代表性任务；不挂载HH开发仓库、不继承开发PATH/缓存。允许用户固件和手册，记录Agent的文件访问与工具行为。

核心门槛：按当前目录验证公开契约（实现后为45项平台与50项硬件工具）；0次HH内部源码依赖；不新增模拟测试产品路径；未知结果0次自动重放；空工程可从公开入口创建并验证程序；`succeeded + passed=false`必须报告业务未通过。

本次只做静态盘点、行为链路核对与方案产出。没有运行发行包Agent评测，不能声称已经消除源码依赖或节省某个百分比。当前工作区存在其他未提交改动，本次未修改它们；报告以读取时实现为依据。
