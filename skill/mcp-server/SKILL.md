---
name: mcp-server
description: Create, extend, review and troubleshoot HardwareHarness hardware MCP servers built on the hardwareharness_device_sdk (mcp_servers/sdk + mcp_servers/adapters/<model>), from a device manual, vendor SDK header/DLL or native CLI. Covers the Device subclass, @tool operation semantics, parameter ranges and units, safe_state, streams (sampled readings, pushed shadows, serial byte traffic) for canvas widgets, get_panel widget templates, pinouts, dry-run simulators, compliance tests and bundle assembly. Use for explicit $mcp-server requests and for any task that adds or changes a hardware service under mcp_servers/. Do not use for FireDAP (still the legacy layout) or for the desktop app itself.
---

# HardwareHarness 硬件 MCP 服务

本技能把一台硬件变成一个 HardwareHarness MCP 服务。服务由 SDK 包 `hardwareharness_device_sdk` 加一个适配器组成。SDK 已经提供传输、鉴权、公共工具、结果信封、生命周期、`safe_state` 调度、流通道和合规测试；适配器只写三件事：驱动映射、声明（语义、流、面板、引脚）、模拟器。

只以本技能的 `references/`、`assets/`、`scripts/` 和仓库里的 `mcp_servers/sdk`、`mcp_servers/adapters/*` 为依据。手册里没有的事实（引脚、量程、安全值、上电状态）不要编：写成 `TODO(new_device)`，或者返回 `not_supported`，再向用户要资料或实测结果。

## 参考适配器

| 适配器 | 看什么 |
|---|---|
| `mcp_servers/adapters/pci6208v` | 最小完整示例：ctypes `WinDLL` 驱动、电压参数带范围、推送型软件影子流、可配置安全值 |
| `mcp_servers/adapters/cp118u_i` | 流式示例：后台读线程 + `io_lock`、`ByteStream` 收发、`read_rx` 游标语义、终端面板 |
| `mcp_servers/adapters/pci1710l` | `SampledStream` + `requires`（未配置时 `not_configured`）、hwcli `JsonLineCli` 子进程驱动 |
| `mcp_servers/adapters/pci1762` | 回读型位图流、成组继电器面板 |

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
6. **声明流、面板、引脚**。按 `references/streams-and-panel.md` 为需要实时显示的量声明流，为画布控件写 `panel.py`，按手册连接器表填 `pinout.py`。
7. **本地验证**：
   ```powershell
   .\skill\mcp-server\scripts\check_adapter.ps1 -Adapter <adapter>
   ```
   依次运行适配器的 pytest、dry-run 合规检查（`--check`），并扫描遗留的 `TODO(new_device)`。全部通过前不要交付。补充测试时对照 `references/checklist.md`。
8. **组装**：由人在 `mcp_servers/servers.json` 增加条目（`id`、`label`、`serverId`、`adapter`、`remoteRoot`、`hardwareId`、`mcpUrl`、`mcpCredentialKey: "mcp:<serverId>"`、`healthUrl`）后，运行 `uv run python tools\assemble.py <adapter>` 生成 `dist/<adapter>/`。
9. **部署交给人**。`.\deploy.ps1 -Server <adapter>` 会写入真实台架电脑，只能由人执行。远端 `server.json`（端口、令牌、`settings`）由人在远端创建，部署不会覆盖它。
10. **首次上架验收**：在软件里注册为草稿服务，空载（不接被测对象）逐个工具手动调用，对照万用表、回环线或继电器动作声确认，再接入测试。

## 硬性规则

- **一服务一硬件**：`list_hardware` 恰好返回一个硬件。多张同型号卡就起多个服务进程，靠 `settings` 区分卡号。
- **安全状态**：必须有一个 `kind="safe"` 的工具（一般就是 `safe_state`），幂等，把所有输出置为手册规定或可配置的安全值。SDK 会在打开后、停止前、停机请求时调用它。安全动作失败时，`details` 里写清哪些通道没到位。
- **不得自动重发**：所有 `kind="actuate"` 工具由 SDK 标为 `retry=never_after_dispatch`。适配器内部也不要对写操作做重试循环。超时或失败不代表没有动作，描述里要写明"先读回或测量再决定"。
- **参数带范围和单位**：每个参数用 `param(type, "含单位和范围的描述", ge=, le=)` 声明。越界必须在调用驱动前拒绝（`INVALID_ARGUMENT`），测试要证明越界值到不了驱动。
- **证据诚实**：读回驱动接受的值写 `controller_state` 或软件影子，不是测量值；只有真正采样物理量才是 `measurement`。描述里写清"它证明什么、不证明什么"。
- **不编造**：不猜引脚号、量程、上电状态。资料缺失时，`pinout()` 保持 `not_supported`，参数范围取手册保守值并标 TODO。
- **流只读**：流和采样函数绝不驱动输出。控制只走 MCP 工具。
- **秘密不进仓库**：不创建、不提交、不部署 `server.json`，不在代码、测试、README 里写令牌或密码。`settings` 只放非秘密配置。
- **不改 FireDAP**：`mcp_servers/servers/firedap/` 仍是旧布局，本技能不处理。

## 参考资料

- `references/contract.md`：服务契约、公共工具、信封、错误类别、操作语义字段。
- `references/sdk-api.md`：`Device`、`@tool`、`param`、`model`、流、面板、配置、模拟器、生命周期。
- `references/streams-and-panel.md`：WebSocket 帧、`stream_read`、采样率选取、串口缓冲、控件模板写法。
- `references/vendor-bindings.md`：ctypes `WinDLL`/`CDLL`、hwcli JSON 行子进程、厂商 stdout。
- `references/checklist.md`：交付前逐项核对。
