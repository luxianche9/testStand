# 交付检查表

逐项核对，每一项都要能指到代码或测试。`check_adapter.ps1` 通过只是最低要求。

## 资料与身份

- [ ] `manufacturer`、`model` 与手册原文一致；`prefix` 小写、唯一，不和现有适配器冲突
- [ ] `pyproject.toml` 声明了入口点 `[project.entry-points."teststand.devices"] <adapter> = "teststand_adapter_<adapter>:DEVICE"`，类型名与适配器目录一致；`uv run python -m teststand_device_sdk --adapter <adapter> --check` 能按类型名找到它
- [ ] `isolation` 有依据：驱动写 stdout、可能崩溃或要求独占进程时为 `subprocess`，否则 `inproc`；README 写明理由
- [ ] 通道数、编号起点（0 或 1）、量程、单位都来自手册，出处写在 README
- [ ] 手册缺失的事实写成 `TODO` 并向用户提出，没有猜测值
- [ ] `instructions` 两三句：设备做什么、先调哪个工具、输出的物理效果
- [ ] `description` 一段：接口、通道、连接器、硬件开关等限制；已知时填 `hardware_revision`

## 驱动与模拟器

- [ ] 每个 ctypes 函数都声明了 `argtypes`/`restype`；`WinDLL`/`CDLL` 按头文件选择
- [ ] DLL/exe 懒加载；找不到时为 `DEVICE_UNREACHABLE`，插件仍能加载（状态 `unreachable`，SDK 退避重开）
- [ ] 驱动只返回原始 rc 和数据，没有业务判断、没有重试
- [ ] 驱动和模拟器实现同一个 Protocol；模拟器的配置门槛和返回码与真实驱动一致
- [ ] 模拟器输入默认读空闲值；演示效果只能由 `HARDWARE_DRY_RUN_*` 环境变量开启
- [ ] 后台线程访问驱动时持有 `io_lock`
- [ ] 适配器和 `inproc` 驱动不往 stdout 打印（后端 stdout 是启动握手）；日志用 `logging`

## 工具

- [ ] 每个工具的 `kind` 正确：会驱动外部信号的就是 `actuate`
- [ ] 描述为英文，≥ 80 字符，写清证明什么、不证明什么、失败后怎么办（写操作："先读回或测量，不要重发"）
- [ ] 每个参数用 `param()` 声明类型、范围、单位；约束与描述一致
- [ ] 越界在调用驱动前拒绝，测试证明越界值没到驱动（检查模拟器写入历史）
- [ ] `requires`/`effects` 成对使用；未配置时返回 `NOT_CONFIGURED`
- [ ] `evidence` 诚实：影子值和驱动接受值不是 `measurement`
- [ ] 所有 `actuate` 工具都有 `safety_action`
- [ ] 失败的 `DeviceError.details` 带 `rc`、`requested`、已生效部分、最后已知状态
- [ ] `output` 模型覆盖返回的全部字段
- [ ] 工具不做通过 / 失败判定：没有期望值、阈值参数，不返回 `pass` / `fail`

## 安全状态

- [ ] 至少一个 `kind="safe"` 工具（通常只有 `safe_state`），幂等，覆盖所有输出
- [ ] 安全值来自手册或 `settings`（并在 `capability_details()` 报告）
- [ ] 部分通道失败时继续处理其余通道，`details` 列出未到位的通道
- [ ] `open()` 之后的 `safe_state` 能把上一次进程遗留的任何输出拉回安全值（后端崩溃不会执行安全收尾）
- [ ] 测试：连续调用两次结果相同；模拟器中所有输出回到安全值

## 流

- [ ] 需要在运行中看到或判定的量都有流；id 与工具参数的通道号对应（`ai3`、`serial2`）
- [ ] 流带手册能证实的元数据：`unit`、`label`、`kind`（`measured` / `setpoint`）、位流的 `width` / `bit_labels`；设定值影子标 `setpoint`
- [ ] 没有硬件定时的波形用 `SoftwareWaveform`，`safe_state` 先 `stop_all()`，`capability_details()` 报告 `waveform_capability(...)`
- [ ] `sample()` / 扫描函数 / `read_block()` 不写任何输出；多通道能一次读就用 `streams.scan`
- [ ] 位图用一次读整个端口的原语；变化少的输入用 `publish_on_change`
- [ ] 采样率在 `settings` 中可调，默认值符合 `streams.md` 的建议，并在 `capability_details()` 报告
- [ ] 未配置时 `sample()` 返回 `None` 或抛 `NOT_CONFIGURED`；事件型流用 `set_state("not_configured")`
- [ ] 有回读的输出写后立即发布（写失败也回读）；没有回读的只在驱动接受后发布设定值
- [ ] 字节流：读线程持 `io_lock` 调 `rx`；每次读返回调 `idle()`（未配置的端口也调），轮询间隔不超过 100 ms；发送只走 `stream.send`（写入器持 `io_lock`、检查配置门槛）；配置 / 清空 / 复位写 `mark`
- [ ] 流记录里没有秘密

## 引脚

- [ ] `pinout()` 来自手册连接器表，否则保持 `not_supported`
- [ ] 针脚名与手册一致；程序里不把针脚和工具、流关联

## 测试与接入

- [ ] `check_adapter.ps1 -Adapter <adapter>` 通过（pytest、`--check` 合规、无 `TODO(new_device)`）
- [ ] `check_device(cls, warnings=warnings)` 无失败且 `warnings == []`
- [ ] 测试覆盖（用 `serve()` 的进程内 harness）：公共工具集合（含内置流工具，不含 `get_pinout` / `list_streams`）、越界拒绝、未配置门槛、`safe_state` 幂等、`hh.device()` 的 `streams`（含元数据）和 `description`、写工具的 `meta.streamRefs` 与记录 `op`、采样流经 `hh.subscribe` 出值、字节流的 `idle()` 水位
- [ ] README 写明：设备类型名、`isolation`、设备语义、流、`settings` 字段、构建原生程序的方法
- [ ] 仓库中没有令牌、密码；`settings` 里只有非秘密配置
- [ ] 接入后端（`app/python/pyproject.toml` 增加依赖与 editable 路径）已告知用户并由用户确认
- [ ] 首次上架由人在设备页先以 `mode: sim`、再以 `mode: real` 空载验收，结束后 `safe_state`；结果记录在 README 或交付说明里
