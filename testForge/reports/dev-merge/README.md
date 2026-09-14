# testForgeDev 后续提交合并

目标仓库：`E:/Project/hardwareHarness`。来源仓库保持不变。

已合入 `85de20e`（前端优化）之后的全部三次提交，并保留目标仓库的 Python 后端和 shadcn 中性主题：

| 来源提交 | 内容 |
| --- | --- |
| `40ba68719fa377142f8c91fe131f61b469a2d16a` | 硬件占用和在线检测抖动修复 |
| `8413a74b5730c9b818d9ef576220a28b13f0be45` | FireDAP MCP Server、STM32 被动板卡、本机执行 |
| `fb7b808ae605c661e70afe10e5a392de8499dd1f` | 案例测试、工程 MCP 工具、工程通知、重启连接修复 |

## 合并处理

- main 继续通过私有 stdio 调用 Python。来源新增的 TS 业务实现已对应移植到 Python，没有恢复七个已删除的 TS 业务包。
- 设备探测按 ID 合并并发请求，探测期间保留上次完整状态；失败和恢复结果正常更新。
- 显式 `execution: local` 使用本机 Shell；旧配置缺少该字段时仍使用 SSH。保留超时、输出限制和非零退出码语义。
- 硬件错误时间允许带时区偏移。校验规则沿用来源 Zod 行为，包括未额外限制偏移的特殊数值。
- 重启按 connect → safe-stop → stop → disconnect → start → connect 顺序执行。
- 新增 get_project、initialize_project、open_project、save_project 四个 MCP 工具；切换保护、Agent 权限和工程通知由 Python 实现。main 根据内部通知同步 OpenCode 工作目录。
- FireDAP 服务、STM32 板卡模型、接线参考及资料原样合入。注册脚本改为 Electron 加密适配器 + Python 的现有存储服务，并更新使用说明。FireDAP 独立依赖锁不改变主后端 MCP 版本。
- 前端保留当前主题，合入本机/远程运行位置选择、电脑名称及状态展示。OpenCode main 文件、依赖和补丁保持不变。
- 原工程、设备、settings 和 secrets 格式继续使用现有 Python 存储实现，没有新增迁移。

## 行为和历史证据

`incoming-evidence.json` 固定来源文件哈希；`new-test-mapping.json` 对应来源新增的 18 个展开用例及 Python 测试。原 117 包用例和 3 个迁移用例的历史证据、golden 文件保持不变，规格门禁继续逐项核验。

旧 tools/list golden 的原 29 个工具仍逐项比较；新增 4 个工具单独验证名称、参数、权限、调用、切换保护和事件。重启断开连接的旧测试断言按来源修复更新。

上一阶段的保护基线保持原文件及哈希，通过 `protected-changes.json` 记录本次授权的 Python 变更；其余原保护项继续检查。当前保护边界共 110 项。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Python ruff / format / mypy strict | 全部通过 | `python-final.txt` |
| Python pytest | 859 通过 | `python-final.txt` |
| 原 120 项规格映射、八包覆盖率门槛、保护哈希 | 全部通过，未降低门槛 | `python-final.txt` |
| TS pnpm verify | 219 测试通过，类型、lint、依赖边界、生产构建通过 | `ts-final.txt` |
| TS 覆盖率 | 通过；行 50.11%，分支 70.86%，函数 61.84% | `ts-coverage.txt` |
| Electron E2E | 27 通过 | `e2e.txt` |
| 三种主题 × 三种窗口尺寸 | 90 张截图及对应控件记录 | `../shadcn/visual/dev-merge/` |
| FireDAP 模拟硬件测试 | 36 通过 | `firedap.txt` |
| Electron safeStorage + Python 注册 | 隔离临时配置成功，14 端口被动板卡导入成功 | `registration-electron.txt` |
| PyInstaller 后端构建 | 通过 | `frozen-build.txt` |
| 冻结进程集成 | 6 通过；子进程移除 Python/uv 环境，仅保留系统 PATH | `frozen-process.txt` |

新增回归还覆盖：本机执行不触发 SSH、2 MiB 输出限制、stop/start 失败顺序、项目切换失败不通知、MCP 工程通知与状态一致且仅一次、隐藏 SSH 凭据不提交，以及注册备份和身份冲突保护。

初始 Python 基线为 835 通过、1 项取消通知测试失败：该测试固定等待 20ms，首次运行未及时收到 HTTP 取消通知。此后完整验证通过；未因此更改生产逻辑或放宽断言。第一轮移植失败记录保留，用于区分旧预期更新和最终结果。

本次使用临时工程、临时配置和模拟硬件验证，没有执行实体板卡烧录。没有宣称完成独立干净 Windows 安装或真实断网验收。
