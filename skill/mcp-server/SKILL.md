---
name: mcp-server
description: Create, extend, review and troubleshoot HardwareHarness hardware MCP servers built on the hardwareharness_device_sdk (mcp_servers/sdk + mcp_servers/adapters/<model>), from a device manual, vendor SDK header/DLL or native CLI. Covers the Device subclass, @tool operation semantics, parameter ranges and units, safe_state, typed read-only streams (scalar/bits/bytes/frames/block/blob: sampled readings, scan groups, write-then-publish readback, serial byte traffic with writer/transact/idle, stream metadata), heartbeat leases, the /device declaration (description, pinout with port images, appearance image) and /assets, schematic diagrams, software waveforms, dry-run simulators, compliance tests and bundle assembly. Use for explicit $mcp-server requests and for any task that adds or changes a hardware service under mcp_servers/. Do not use for FireDAP (still the legacy layout) or for the desktop app itself.
---

# HardwareHarness 硬件 MCP 服务

本技能把一台硬件变成一个 HardwareHarness MCP 服务。服务由 SDK 包 `hardwareharness_device_sdk` 加一个适配器组成。SDK 已经提供传输、鉴权、公共工具、结果信封、心跳租约、生命周期、`safe_state` 调度、`/device` 设备声明与 `/assets` 图片、流的时间戳 / 缓冲 / 采样线程 / 操作号 / 水位 / SSE 通道、示意图生成、软件波形和合规测试；适配器只写三件事：驱动映射、声明（设备描述、工具语义、流及其元数据、引脚与图片）、模拟器。

只以本技能的 `references/`、`assets/`、`scripts/` 和仓库里的 `mcp_servers/sdk`、`mcp_servers/adapters/*` 为依据。手册里没有的事实（引脚、量程、安全值、上电状态）不要编：写成 `TODO(new_device)`，或者返回 `not_supported`，再向用户要资料或实测结果。

## 参考适配器

| 适配器 | 看什么 |
|---|---|
| `mcp_servers/adapters/pci6208v` | 最小完整示例：ctypes `WinDLL` 驱动、电压参数带范围、`kind="setpoint"` 的 `scalar` 写即发布、`SoftwareWaveform` 软件波形、可配置安全值、模拟台输出、D-sub 端口图 |
| `mcp_servers/adapters/cp118u_i` | 字节流示例：后台读线程 + `io_lock`、每次读返回调 `idle()`、`ByteStream` 写入器 / `send` / `mark`、`read_rx` 游标语义、`transact`、多个连接器共用一张端口图 |
| `mcp_servers/adapters/pci1710l` | `scalar` 扫描组（16 路共享 `t`）、`requires`（未配置时 `not_configured`）、hwcli `JsonLineCli` 子进程驱动、模拟台输入 |
| `mcp_servers/adapters/pci1762` | `bits` 流 `publish_on_change`（带 `width` / `bit_labels`）、写后回读发布、一次读整个端口 |

## 流程

1. **读资料**。从手册或 SDK 头文件整理：型号与厂商原文、通道数与编号起点、每个操作的参数（类型、范围、单位）、返回值含义、上电和安全状态、错误码、连接器引脚表。区分"控制器状态"（寄存器、驱动接受的值）和"测量值"，这决定 `evidence`。
2. **生成骨架**（在仓库根目录）：
   ```powershell
   uv run --project mcp_servers python skill/mcp-server/scripts/new_device.py <adapter> --prefix <prefix> --model <MODEL> --manufacturer <Vendor>
   ```
   生成 `mcp_servers/adapters/<adapter>/`，并登记到 `mcp_servers/pyproject.toml` 的 uv 工作区。骨架是一张数字 I/O 卡，开箱即通过合规检查，但带有若干 `TODO(new_device)`。
3. **写驱动 `driver.py`**。只做厂商调用的类型化封装，返回原始返回码和数据，不做业务判断。写法见 `references/vendor-bindings.md`。
4. **写模拟器 `sim.py`**。与驱动同接口，忠实模拟控制器状态（影子寄存器、配置门槛），输入读成空闲值（0 V、低电平、无 RX）。演示用的噪声、回环只能用环境变量开启。
5. **写适配器 `adapter.py`**。按 `references/sdk-api.md` 把每个操作写成 `@tool`：声明 `kind`、`requires`、`effects`、`evidence`、`safety_action`；每个参数用 `param()` 写清范围和单位；失败时抛 `DeviceError`，`details` 里带上部分效果。
6. **声明流、引脚和图片**。按 `references/streams.md` 为运行中需要看到的量声明类型化的流（采样型给 `sample()`，输出写后发布回读，串口给写入器、写 `mark`、每次读返回调 `idle()`），并用构造参数写上元数据：`unit`、`label`、`kind`（`measured` 测量 / `setpoint` 设定值影子）、位流的 `width` / `bit_labels`。按手册连接器表填 `pinout.py`，用 SDK 的 `diagram` 模块（`render_port`、`render_board`）生成端口示意图和外观图放进 `assets/`，用 `attach_port_image` 挂到连接器上（见 `references/sdk-api.md`）。给 `Device.description` 写一段设备描述。这些都出现在 `/device` 里，`--check` 对缺失的图片和描述给出警告。
7. **本地验证**：
   ```powershell
   .\skill\mcp-server\scripts\check_adapter.ps1 -Adapter <adapter>
   ```
   依次运行适配器的 pytest、dry-run 合规检查（`--check`），并扫描遗留的 `TODO(new_device)`。全部通过前不要交付。补充测试时对照 `references/checklist.md`。
8. **组装**：不用登记任何清单文件，电脑、服务和硬件都在终端的注册表里。部署时终端自己打包；只想检查打包结果时，在 `HardwareHarness/python` 下运行 `uv run python -m hardwareharness_backend.devices.deploy assemble --server-id <SERVER_ID> --hardware-id <hardwareId> --adapter <adapter>`，生成 `mcp_servers/dist/<SERVER_ID>/`。
9. **部署交给人**。部署会写入真实台架电脑，由人在终端设备页点“部署服务”发起（或维护者运行 `.\deploy.ps1`，参数见 `mcp_servers/README.md`）；本技能从不部署。远端 `server.json`（身份、端口、令牌、`settings`）由 HardwareHarness 终端在首次安装时生成，令牌存在终端的秘密存储里（`mcp:<serverId>`），重装保留已有文件（设计 4.7）；部署不会覆盖它，本技能也从不创建它。`install.ps1` 登记 `C:\ProgramData\HardwareHarness\services.json` 并（默认 `-AutoStart`）注册开机任务，`uninstall.ps1` 撤销这两项。
10. **首次上架验收**：在软件里注册为草稿服务，空载（不接被测对象）逐个工具手动调用，对照万用表、回环线或继电器动作声确认，再接入测试。

## 硬性规则

- **一服务一硬件**：`list_hardware` 恰好返回一个硬件。多张同型号卡就起多个服务进程，靠 `settings` 区分卡号。
- **安全状态**：必须有一个 `kind="safe"` 的工具（一般就是 `safe_state`），幂等，把所有输出置为手册规定或可配置的安全值。SDK 会在打开后、停止前、停机请求时调用它。安全动作失败时，`details` 里写清哪些通道没到位。
- **不得自动重发**：所有 `kind="actuate"` 工具由 SDK 标为 `retry=never_after_dispatch`。适配器内部也不要对写操作做重试循环。超时或失败不代表没有动作，描述里要写明"先读回或测量再决定"。
- **参数带范围和单位**：每个参数用 `param(type, "含单位和范围的描述", ge=, le=)` 声明。越界必须在调用驱动前拒绝（`INVALID_ARGUMENT`），测试要证明越界值到不了驱动。
- **证据诚实**：读回驱动接受的值写 `controller_state` 或软件影子，不是测量值；只有真正采样物理量才是 `measurement`。描述里写清"它证明什么、不证明什么"。
- **不编造**：不猜引脚号、量程、上电状态。资料缺失时，`pinout()` 保持 `not_supported`，参数范围取手册保守值并标 TODO。
- **流只读**：流和采样函数绝不驱动输出。控制只走 MCP 工具。
- **声明而不关联**：流的元数据（`unit`、`label`、`kind`、`width`、`bit_labels`）、针脚表和图片都只是声明，供 AI 生成接线方案、供人和运行监控页显示；程序里不把流、工具和针脚互相关联。安全范围只在服务内校验，越界直接报错。
- **服务不判定**：服务只报告测量值、控制器状态和流，不做通过 / 失败判定（没有阈值比较、期望值、窗口统计或等待条件）；判定属于测试步骤。`transact` 的 `expect` 只是传输层的等应答。
- **并发交给 SDK**：不自己起采样线程、不自己打时间戳；只有设备要求的后台读线程（串口）由适配器写，持 `io_lock`，每次读返回调 `stream.idle()`。没有硬件定时的输出要出波形时用 SDK 的 `SoftwareWaveform`，不自己写定时循环。
- **秘密不进仓库**：不创建、不提交、不部署 `server.json`，不在代码、测试、README 里写令牌或密码。`settings` 只放非秘密配置。
- **不改 FireDAP**：`mcp_servers/servers/firedap/` 仍是旧布局，本技能不处理。

## 参考资料

- `references/contract.md`：服务契约（`contractRevision` `2026-10-01.1`）、`/device` 与 `/assets`、公共工具、请求 `_meta`、心跳租约、信封 `meta`、错误类别、操作语义字段。
- `references/sdk-api.md`：`Device`（含 `description`、图片）、`@tool`、`param`、`model`、配置、示意图、软件波形、模拟器、测试工具、生命周期。
- `references/streams.md`：流类型与记录、流元数据、采样与扫描组、写即发布、字节流配方与 `idle()`、状态、SSE 事件与水位、内置 `stream_read` / `transact`。
- `references/vendor-bindings.md`：ctypes `WinDLL`/`CDLL`、hwcli JSON 行子进程、厂商 stdout。
- `references/checklist.md`：交付前逐项核对。
