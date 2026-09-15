# HH 发行版 Agent 接口优化实施记录

日期：2026-09-15。用户授权实施完整优化方案，并明确删除模拟测试要求，不增加模拟测试功能。原始历史分析和逐工具审查保留为实施前证据；本文件记录最终实现和实际验收范围。

## 已实现

平台公开工具由 34 项增至 45 项；五类硬件服务由 49 项增至 50 项，共 95 项静态预期公开工具。在线实际目录仍受服务连接与用户权限影响。

五个内部接口都是各服务自己的 `hardwareharness_prepare_shutdown`，分别属于 CP118U_I_MCP、PCI1710L_MCP、PCI6208V_MCP、PCI1762_MCP、FIREDAP_MCP。它们用于平台关闭服务前的清理，继续隐藏。

新增平台工具：

| 工具 | 提供的信息或动作 |
| --- | --- |
| get_agent_context | 当前版本、契约修订、目录修订、工程、环境、脚本规则和资料索引；未打开工程也可查询 |
| get_tool_contract | 按名称获取参数、输出、错误恢复、SDK名称/返回契约；支持搜索与分页 |
| read_reference | 随包指南及已登记用户资料的检索、来源、哈希、分页 |
| register_reference | 导入用户工程内的 UTF-8 文本资料，绑定硬件并校验更新哈希 |
| create_workspace_file | 独占创建 scripts/*.py；已有文件继续使用 expectedHash 更新 |
| get_execution_availability | 当前硬件观测、运行冲突和持有活动；查询不等于预留资源 |
| get_python_run_summary | Run 状态、业务结果、事件摘要、全部已登记附件和原始源码引用 |
| read_python_run_source | 从 Run 源码快照分页读取，并验证原始哈希 |
| read_python_run_artifact | 分页读取附件、较大业务返回值和事件原文 |
| wait_for_status | 对现有 Run、接线待办或服务状态有界等待；不重提原动作 |
| import_firmware_artifact | 将用户工程固件直接传入目标服务的受管存储，避免在模型请求中搬运大段 base64 |

新增硬件工具 `firedap_import_firmware`：严格检查扩展名、base64、SHA-256 和 32 MiB 上限，以内容寻址方式独占创建。返回服务端接受的文件路径、artifactId、哈希和大小；导入不会烧录，仍需 inspect，BIN 仍需 base_address。

## 契约、提示词与兼容性

- 现有 34 个平台工具补齐用途、字段说明、输出 schema 与副作用提示；全部 50 个硬件工具经过实际 FastMCP 注册和序列化验证。
- 聚合层保留可支持的参数/结果/annotations/契约元数据，正确处理 hardwareId 注入、工具名称和响应解包。内部关闭工具及不支持的任务执行声明不作为公开 Agent 能力。
- 公开输出 schema 同时接受成功和真实错误响应。捆绑的 TypeScript MCP 客户端会校验错误的 structuredContent；缺少错误分支会掩盖文件冲突等恢复详情，已据实际客户端发现并修复。
- SDK 保持六个公开 API，call/acall 默认仍返回完整 envelope；新代码可以显式使用 result_mode="data"。运行日志保留选择前的原始响应及媒体。SDK 工具名使用平台实际接受的聚合名称，另外保留远端工具名供诊断。
- OpenCode build/plan 与 MCP initialize 使用同一份随包指令。明确通过公开资料、工具契约和运行证据了解 HH；用户自己的项目代码、固件及资料仍可正常读取。
- 提示词、SDK 指南与产品文档删除模拟测试要求。没有新增模拟入口、模拟能力开关或运行模式。开发者契约测试使用受控替身，与产品功能分开。
- 指南按契约修订发布；保留用户修改过的旧指南。环境检测旧 SDK 修订后重装当前随包 wheel，验证安装结果后才标记 ready。离线重装使用 --reinstall-package，避免与 --offline 不兼容的 --refresh-package。

## 执行与证据语义

- 硬件目录返回可直接复制的 endpointRef 和结构化端点。保留旧规范引用；只接受无歧义的简称。同端口回环需真实、不同的 pinId，拒绝重复或自接针脚。
- 接线请求、人工确认、工程保存和电气测量分别表示不同事实；终态不能被再次确认，确认与取消按任务串行处理。
- 允许内置服务的明确资料/状态查询在 Run 期间执行；硬件动作仍检查冲突。第三方 readOnlyHint 本身不能解除执行门控。
- 错误保留类别、校验问题和恢复详情；敏感键脱敏。超时、取消及无效远端响应不代表物理动作未发生，不自动重放硬件操作。
- 修正并公开串口通道索引、帧格式与累计 RX 语义；明确 AO read_last 是软件影子、safe_state 使用有效配置值、继电器控制回读不等于触点测量。
- Run 正常退出与业务 passed=false 分开；恢复后的 interrupted 状态也纳入公开契约。
- 修复 Windows 冻结后端启动外部 Python 的 DLL 搜索路径继承问题，环境准备、诊断和实际程序运行共用启动处理；不会修改机器的全局环境配置。

## 验证记录

稳定代码上的 `uv run python scripts/verify.py` 完整通过：1002 项 Python 测试、Ruff 检查/格式、严格 mypy、79 项保留规格、固定证据、逐包覆盖率门槛及受保护文件哈希检查。没有降低覆盖率要求。

桌面端 243 项测试、TypeScript 类型检查、lint、导入/依赖/品牌检查与生产构建全部通过。硬件服务 95 项测试通过，覆盖全部 50 个公开工具的实际 FastMCP 序列化、SDK envelope 和网关结果契约；另在最低支持 MCP 1.26 上通过 2 项契约检查。

重新冻结的后端在临时中文工程中通过公开 MCP 验收：仅使用迁移后的随包运行时，PATH 仅保留 System32，使用全新离线依赖缓存。验证 45 个公开平台工具、124 行随包指南读取、文件哈希冲突详情、静态诊断、真实 Python 进程、41 条运行事件分页、原始源码一致性及 3 页附件读取。程序正常退出且业务结果 passed=false 得到分别保留。后端退出码为 0，临时资源下没有遗留进程。

证据：[冻结版公开 MCP 验收](E:/Project/hardwareHarness/reports/agent-interface-review-2026-09-15/frozen-public-mcp-smoke.json)。隔离构建产物位于 `HardwareHarness/python/dist/agent-interface-release/hardwareharness-backend`；没有替换已部署服务。

原有保护基线、历史例外和覆盖率门槛保持不变。本次有授权的 6 个受保护文件变更单独记入 `HardwareHarness/reports/agent-interface/protected-changes.json`，逐项记录前后哈希与原因，检查器继续拒绝范围外变化。

## 验证边界

没有操作真实硬件、重启或部署正在使用的远端服务；服务修改需随新版服务包发布后生效。没有运行真实模型的多轮任务基准，也不将确定性 MCP 验收当作模型行为成功率。

用户参考资料目前支持 UTF-8 `.md/.txt/.json/.csv`，不提供 PDF 提取。服务无法可靠查询的驱动/硬件版本如实返回 unknown。旧驱动已有的开发覆盖分支保持原状，没有作为产品模拟功能公开。普通用户 Python 程序不宣称运行在 OS 沙箱中。

尚未声明支持 MCP resources 或 deferred tasks；资料有明确工具入口。对第三方任意 allOf 组合输出，聚合数据 schema 保守放宽，原始 SDK schema 保留；本次五类服务的实际输出契约均通过完整校验。冻结验收不是独立干净 Windows 安装机验收，也不是实时模型行为基准。
