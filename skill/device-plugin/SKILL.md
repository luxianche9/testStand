---
name: device-plugin
description: Create, extend, review and troubleshoot testStand device plugins built on the teststand_device_sdk (devices/sdk + devices/adapters/<model>), from a device manual, vendor SDK header/DLL or native CLI. Covers the Device subclass, the teststand.devices entry point, Device.isolation (inproc / subprocess), @tool operation semantics, parameter ranges and units, safe_state, typed read-only streams (scalar/bits/bytes/frames/block/blob: sampled readings, scan groups, write-then-publish readback, serial byte traffic with writer/transact/idle, stream metadata), the generated /device declaration (description, pinout, streams, capabilities), software waveforms, simulators (mode sim / dry-run), the in-process test harness and the --check compliance suite. Use for explicit $device-plugin requests and for any task that adds or changes a device adapter under devices/. Do not use for the desktop app itself.
---

# testStand 设备插件

本技能把一台硬件变成一个 testStand 设备插件。插件由 SDK 包 `teststand_device_sdk` 加一个适配器包组成，由 testStand 后端在本机加载：默认在后端进程内运行，适配器声明需要隔离时在一个 stdio 子进程里运行。SDK 已经提供工具注册、公共工具、结果信封、操作号、生命周期与 `safe_state` 调度、`/device` 设备声明、流的时间戳 / 缓冲 / 采样线程 / 水位、软件波形、子进程隔离、进程内测试工具和合规检查；适配器只写三件事：驱动映射、声明（设备描述、工具语义、流及其元数据、引脚）、模拟器。

只以本技能的 `references/`、`assets/`、`scripts/` 和仓库里的 `devices/sdk`、`devices/adapters/*` 为依据。手册里没有的事实（引脚、量程、安全值、上电状态）不要编：写成 `TODO(new_device)`，或者返回 `not_supported`，再向用户要资料或实测结果。

## 参考适配器

| 适配器 | 看什么 |
|---|---|
| `devices/adapters/pci6208v` | 最小完整示例：ctypes `WinDLL` 驱动、电压参数带范围、`kind="setpoint"` 的 `scalar` 写即发布、`SoftwareWaveform` 软件波形、可配置安全值；`isolation = "subprocess"`（PCIS-DASK 加载时写 stdout） |
| `devices/adapters/cp118u_i` | 字节流示例：后台读线程 + `io_lock`、每次读返回调 `idle()`、`ByteStream` 写入器 / `send` / `mark`、`read_rx` 游标语义、`transact` |
| `devices/adapters/pci1710l` | `scalar` 扫描组（16 路共享 `t`）、`requires`（未配置时 `not_configured`）、hwcli `JsonLineCli` 子进程驱动 |
| `devices/adapters/pci1762` | `bits` 流 `publish_on_change`（带 `width` / `bit_labels`）、写后回读发布、一次读整个端口 |

## 流程

1. **读资料**。从手册或 SDK 头文件整理：型号与厂商原文、通道数与编号起点、每个操作的参数（类型、范围、单位）、返回值含义、上电和安全状态、错误码、连接器引脚表。区分"控制器状态"（寄存器、驱动接受的值）和"测量值"，这决定 `evidence`。同时确认驱动会不会往 stdout 打印、会不会崩溃拖垮宿主进程，这决定 `isolation`（第 5 步）。
2. **生成骨架**（在仓库根目录）：
   ```powershell
   uv run --project devices python skill/device-plugin/scripts/new_device.py <adapter> --prefix <prefix> --model <MODEL> --manufacturer <Vendor>
   ```
   生成 `devices/adapters/<adapter>/`，在它的 `pyproject.toml` 里声明入口点 `[project.entry-points."teststand.devices"] <adapter> = "teststand_adapter_<adapter>:DEVICE"`，并登记到 `devices/pyproject.toml` 的 uv 工作区。入口点名就是设备类型。骨架是一张数字 I/O 卡，开箱即通过合规检查，但带有若干 `TODO(new_device)`。
3. **写驱动 `driver.py`**。只做厂商调用的类型化封装，返回原始返回码和数据，不做业务判断。写法见 `references/vendor-bindings.md`。
4. **写模拟器 `sim.py`**。与驱动同接口，忠实模拟控制器状态（影子寄存器、配置门槛），输入读成空闲值（0 V、低电平、无 RX）。演示用的噪声、回环只能用环境变量开启。适配器单元测试和 `--check` 用 SDK 的 `dry_run` 让 `select_driver` 选它；testStand 里的设备总是用真实驱动，没有模拟运行。
5. **写适配器 `adapter.py`**。按 `references/sdk-api.md` 把每个操作写成 `@tool`：声明 `kind`、`requires`、`effects`、`evidence`、`safety_action`；每个参数用 `param()` 写清范围和单位；失败时抛 `DeviceError`，`details` 里带上部分效果。驱动加载时写 stdout、可能崩溃或必须独占进程时，设类属性 `isolation = "subprocess"`；否则保持默认 `inproc`。
6. **声明流和引脚**。按 `references/streams.md` 为运行中需要看到的量声明类型化的流（采样型给 `sample()`，输出写后发布回读，串口给写入器、写 `mark`、每次读返回调 `idle()`），并用构造参数写上元数据：`unit`、`label`、`kind`（`measured` 测量 / `setpoint` 设定值影子）、位流的 `width` / `bit_labels`。按手册连接器表填 `pinout.py`。给 `Device.description` 写一段设备描述。这些都出现在 `/device` 里，`--check` 对缺失的描述给出警告。
7. **本地验证**：
   ```powershell
   .\skill\device-plugin\scripts\check_adapter.ps1 -Adapter <adapter>
   ```
   依次运行适配器的 pytest、模拟器上的合规检查（`--check`），并扫描遗留的 `TODO(new_device)`。全部通过前不要交付。补充测试时对照 `references/checklist.md`。
8. **打成设备包**。在适配器 `pyproject.toml` 的 `[tool.teststand.package]` 写上 `vendorDrivers`（台架需预装的厂商驱动，安装时显示给用户）和 `requiredFiles`（必须进 wheel 的文件，如 `bin/*.exe`），再运行 `python devices/pack.py <adapter>`：它先跑测试和 `--check`，再构建 wheel（连同第三方依赖的 wheel）写出 `devices/dist/<类型>-<版本>.tsdev`。testStand 本身不改、不重新打包：用户在测试台架点“+ → 添加设备…”选这个文件，确认清单（设备、厂商驱动、SHA-256）、填名称和实物/模拟后添加，设备立即可调用；驱动升级在重启 testStand 后生效。
9. **首次上架验收交给人**。在测试台架上添加设备，把它拖到画布上，空载（不接被测对象）用卡片的“控制”逐个动作执行，对照万用表、回环线或继电器动作声确认，结束后执行 `safe_state`。这一步由人完成，本技能不替人确认。

## 硬性规则

- **一实例一硬件**：`list_hardware` 恰好返回一个硬件。多张同型号卡就添加多个实例，靠 `settings` 区分卡号。
- **安全状态**：必须有一个 `kind="safe"` 的工具（一般就是 `safe_state`），幂等，把所有输出置为手册规定或可配置的安全值。SDK 在打开后、关闭前调用它；后端正常退出时对所有已打开的设备调用它，测试运行中止时也调用它。后端崩溃时不保证（没有看门狗），所以 `open()` 之后的第一次 `safe_state` 必须能把任何遗留输出拉回安全值。安全动作失败时，`details` 里写清哪些通道没到位。
- **不得自动重发**：所有 `kind="actuate"` 工具由 SDK 标为 `retry=never_after_dispatch`。适配器内部也不要对写操作做重试循环。超时、子进程崩溃或失败不代表没有动作，描述里要写明"先读回或测量再决定"。
- **参数带范围和单位**：每个参数用 `param(type, "含单位和范围的描述", ge=, le=)` 声明。越界必须在调用驱动前拒绝（`INVALID_ARGUMENT`），测试要证明越界值到不了驱动。
- **证据诚实**：读回驱动接受的值写 `controller_state` 或软件影子，不是测量值；只有真正采样物理量才是 `measurement`。描述里写清"它证明什么、不证明什么"。
- **不编造**：不猜引脚号、量程、上电状态。资料缺失时，`pinout()` 保持 `not_supported`，参数范围取手册保守值并标 TODO。
- **流只读**：流和采样函数绝不驱动输出。控制只走工具。
- **声明而不关联**：流的元数据（`unit`、`label`、`kind`、`width`、`bit_labels`）、针脚表都只是声明，供 AI 生成接线方案、供人和运行监控页显示；程序里不把流、工具和针脚互相关联。安全范围只在插件内校验，越界直接报错。
- **插件不判定**：插件只报告测量值、控制器状态和流，不做通过 / 失败判定（没有阈值比较、期望值、窗口统计或等待条件）；判定属于测试步骤。`transact` 的 `expect` 只是传输层的等应答。
- **并发交给 SDK**：不自己起采样线程、不自己打时间戳；只有设备要求的后台读线程（串口）由适配器写，持 `io_lock`，每次读返回调 `stream.idle()`。没有硬件定时的输出要出波形时用 SDK 的 `SoftwareWaveform`，不自己写定时循环。
- **stdout 不归适配器**：`inproc` 插件和后端共用进程，后端 stdout 的第一行是给桌面应用的启动握手，适配器和驱动都不许往 stdout 打印；驱动会打印就设 `isolation = "subprocess"`（子进程把文件描述符 1 指向 stderr）。日志用 `logging`。
- **秘密不进配置**：`settings` 只放非秘密配置（卡号、DLL 路径、COM 口、采样率、安全值），不在代码、测试、README 里写令牌或密码。

## 参考资料

- `references/contract.md`：插件契约（`contractRevision` `2026-10-08.1`）、加载方式与隔离、`/device`、公共工具、操作号、信封 `meta`、错误类别、操作语义字段、生命周期。
- `references/sdk-api.md`：`Device`（含 `description`、`isolation`）、入口点、`@tool`、`param`、`model`、配置、软件波形、模拟器、测试工具。
- `references/streams.md`：流类型与记录、流元数据、采样与扫描组、写即发布、字节流配方与 `idle()`、状态、读取与水位、内置 `stream_read` / `transact`。
- `references/vendor-bindings.md`：ctypes `WinDLL`/`CDLL`、hwcli JSON 行子进程、厂商 stdout 与子进程隔离。
- `references/checklist.md`：交付前逐项核对。
