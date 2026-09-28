# 交付检查表

逐项核对，每一项都要能指到代码或测试。`check_adapter.ps1` 通过只是最低要求。

## 资料与身份

- [ ] `manufacturer`、`model` 与手册原文一致；`prefix` 小写、唯一，不和现有适配器冲突
- [ ] 通道数、编号起点（0 或 1）、量程、单位都来自手册，出处写在 README
- [ ] 手册缺失的事实写成 `TODO` 并向用户提出，没有猜测值
- [ ] `instructions` 两三句：设备做什么、先调哪个工具、输出的物理效果

## 驱动与模拟器

- [ ] 每个 ctypes 函数都声明了 `argtypes`/`restype`；`WinDLL`/`CDLL` 按头文件选择
- [ ] DLL/exe 懒加载；找不到时为 `DEVICE_UNREACHABLE`，服务仍能启动
- [ ] 驱动只返回原始 rc 和数据，没有业务判断、没有重试
- [ ] 驱动和模拟器实现同一个 Protocol；模拟器的配置门槛和返回码与真实驱动一致
- [ ] 模拟器输入默认读空闲值；演示效果只能由 `HARDWARE_DRY_RUN_*` 环境变量开启
- [ ] 后台线程访问驱动时持有 `io_lock`

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

## 安全状态

- [ ] 至少一个 `kind="safe"` 工具（通常只有 `safe_state`），幂等，覆盖所有输出
- [ ] 安全值来自手册或 `settings`（并在 `capability_details()` 报告）
- [ ] 部分通道失败时继续处理其余通道，`details` 列出未到位的通道
- [ ] 测试：连续调用两次结果相同；模拟器中所有输出回到安全值

## 流与面板

- [ ] 需要实时显示的量都有流；`sample()` 不写任何输出
- [ ] 采样率在 `settings` 中可调，默认值符合 `streams-and-panel.md` 的建议
- [ ] 采样流需要配置时声明 `requires`，未配置时状态为 `not_configured`
- [ ] 字节流只记录驱动实际接受的 tx 字节
- [ ] 面板每个写控件的 `range`/`options` 与工具参数一致；驱动外部信号的控件 `confirm=True`
- [ ] 面板有绑定 `safe_state` 的 `button`
- [ ] 没有回读流的写控件在描述里说明"显示的是最后写入值"
- [ ] 流条目和面板里没有秘密

## 引脚

- [ ] `pinout()` 来自手册连接器表，否则保持 `not_supported`
- [ ] 面板 `pins` 引用的 `pinId` 都存在

## 测试与组装

- [ ] `check_adapter.ps1 -Adapter <adapter>` 通过（pytest、`--check` 合规、无 `TODO(new_device)`）
- [ ] 测试覆盖：公共工具数量与 `outputSchema`、越界拒绝、未配置门槛、`safe_state` 幂等、流 `hello`/`batch`、面板引用
- [ ] README 写明：设备语义、流与面板、`settings` 字段、构建原生程序的方法、部署注意事项
- [ ] 仓库中没有 `server.json`、令牌、密码
- [ ] `servers.json` 条目与 `assemble.py` 由人添加和运行；部署到真实台架由人执行
- [ ] 首次上架按草稿服务空载验收，结果记录在 README 或交付说明里
