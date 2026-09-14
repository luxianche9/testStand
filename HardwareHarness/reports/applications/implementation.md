# HardwareHarness 应用搭建交付记录

实施参考 revision：`2ecde3ff6c610658a4ea05bb130e26c321e20b6d`。
验证日期：2026-09-14。代码未提交；现有设备登记成果、`mcp_servers` 和当前示例工程保留。

## 已实现

“编排测试”替换为“应用搭建”：工作区文件树、CodeMirror 多标签编辑器、搜索与文件操作、
未保存内容恢复、外部编辑冲突提示、Python/Ruff 诊断、独立 FastAPI Web 预览，以及新的
Run/Step/Event 日志界面。标签、应用选择与面板宽度持久化。没有加入交互式终端或调试器。

项目使用 `.hardwareharness` 下的共享 uv 环境。流程入口为 `main(inputs)`，支持同步和
异步；平台保存代码快照、输入、依赖锁与版本信息后，在独立 Python 进程执行。每个 Web
业务操作生成独立 Run，常驻服务与硬件执行进程分开。默认模板随包提供；额外依赖可通过
明确的“联网安装依赖”操作安装，未保存文件和活动进程会阻止环境变更。

独立带类型的 `hardwareharness` SDK 公开 `call`、`acall`、`step`、`log`、`measurement`、
`attachment`。平台自动关联运行身份，不向业务代码暴露占用、接线、人工确认、项目或 Run
管理接口。SDK 不直接连接硬件 MCP。平台逐次验证占用、公开工具、参数和声明硬件，并与
手动调用、Agent 直接调用共享执行互斥；缺少占用或冲突立即报错，不排队、不自动重放。

事件使用顺序 JSONL 持久化。调用开始日志成功落盘后才发送硬件请求，后续日志失败会停止
新调用。支持步骤树、输出、异常源码位置、测量、附件、历史分页和导出。取消先协作退出，
10 秒后终止进程树；重启后未完成 Run 标为中断。超时和取消不宣称硬件操作已撤销。

预览使用独立 localhost iframe、应用范围认证及 Host/Origin 检查，没有 Electron preload、
Node 或 desktop bridge。实际 Electron 跨站预览使用独立 HttpOnly / Secure /
SameSite=None / Partitioned cookie。停止应用、切换项目和退出会清理相关进程。

MCP 的节点工具已退出，改为应用、文件、流程和日志工具。初始化指引明确六步开发顺序：
检查设备能力与资料 → 接线和占用 → 编写代码 → 模拟硬件测试 → 真实执行 → 检查日志。
OpenCode 页面、`main/opencode-*.ts`、react-opencode 依赖和补丁保持不变。

v1–v3 工程首次打开时，先保存并验证原始清单和旧 Run 的备份，再原子写入无 `task` 的 v4。
旧任务不翻译为 Python，旧 Run 只留原始备份，不出现在新界面。详见
[转换报告](migration-report.md)、[验收映射](acceptance-map.md) 与 retirement 清单。

## 检查结果

| 检查 | 结果 | 原始证据 |
|---|---|---|
| Ruff、格式、mypy strict（源码、SDK、测试） | 通过 | `python-verify.txt` |
| Python 全量 pytest | 968 通过 | `python-verify.txt` |
| 原规格映射 | 83 项保留规格通过，37 项节点/旧 Run 规格按批准计划退役；固定历史证据校验通过 | `../../python/reports/retired-specifications.json`、`../../python/reports/python-spec-results.json` |
| 保留包覆盖率 | 未降低原行/分支门槛，全部通过 | `../../python/reports/coverage-comparison.json` |
| SDK 行 / 分支 | 99.51% / 97.50% | 同上 |
| 执行模块行 / 分支 | 99.68% / 93.86% | 同上 |
| 工作区模块行 / 分支 | 96.24% / 93.94% | 同上 |
| 受保护源码 | 23 项保护规则通过；OpenCode 和补丁无 diff | `python-verify.txt`、`protected-files.json` |
| `pnpm verify` | 通过，8 contracts + 229 desktop = 237 测试 | `pnpm-verify.txt` |
| TS 覆盖率 | 行/语句 54.00%、分支 72.34%、函数 61.08%，阈值未降低 | `ts-coverage.txt` |
| Electron E2E | 28 / 28，通过构建好的离线项目 runtime | `electron-e2e.txt` |
| 主题和尺寸 | 浅色、深色、系统；960×600、1280×800、1600×1000 | `visual/after/`、`embedded-preview.png` |

完整 Python 门禁同时核对测试前后源码哈希一致。一次并行构建期间的旧 MCP 测试因固定
20 毫秒等待尚未收到取消通知而失败；改为等待测试服务端的实际接收事件后全量通过，
保留“恰好一次取消、对应请求 ID、连接仍可用”的全部断言，生产超时没有修改。
原始失败输出保留为 `python-verify-transient.txt`。

最终审查还补齐了项目切换期间启动防护、Agent 直接调用互斥、生产 Ruff 诊断路径、已结束
Run 超过 500 条事件的 SSE 全分页读取，以及显式联网安装选项。依赖安装期间也禁止使用
旧的 ready 环境启动新进程，回归见 `environment-race-before.txt` 和
`tests/workspace/test_environment_launch_race.py`。均先建立回归再修复。

原 SDK 适配增加 `preserveEnvelope` 可选行为，保留完整 MCP `content` 和
`structuredContent`；现有手动和 Agent 直接调用默认返回值不变。该唯一设备源码保护例外
及前后哈希见 `protected-changes.json`，回归见 `tests/devices/test_sdk_envelope.py`。

## Windows 交付与实测边界

后端冻结程序与项目解释器分开交付。安装资源包含 CPython 3.11.15、uv 0.11.32、SDK wheel
和默认 FastAPI/检查工具的完整离线依赖；项目环境创建在可写项目目录。

最终安装包：`dist/HardwareHarness-0.1.0-windows-x64.exe`，280625529 字节。
SHA256：`FD97338FE9B064745431EC8AFB993A3F72BD84385EADC141162D1D4F2DC87899`。
打包目录中 258 个后端文件与最新冻结输出逐项 SHA256 一致，见
`packaging/backend-payload.json`。

冻结版冒烟已通过中文及空格工程、仅 System32 PATH、空缓存与离线安装依赖、默认 FastAPI
页面、两次独立 Run、iframe 能力隔离、OpenCode 侧栏及重启、应用停止与完整进程树退出。
隐藏验收窗口通过 DOM 表单提交保留原有校验、事件与 API 链路；真实鼠标和键盘交互由
可见窗口的 28 项 Electron E2E 覆盖。

最终 NSIS 已实际安装到 `dist/安装 验收`，258 个安装后的后端文件再次逐项核对一致。
对安装目录设置禁止写入 ACL 并用写探针确认有效后，safeStorage 兼容 E2E、默认离线环境、
两次独立应用操作及 OpenCode 重启全部通过。测试已执行卸载。进程审计覆盖 Electron、
冻结后端、uv、应用服务、Python worker 和 OpenCode；观察到的进程全部退出。
原始安装记录见 `packaging/installed-acceptance.log`，安装版 Run 证据见
`packaging/packaged-applications.json`，进程证据见 `packaging/process-cleanup.json`。
卸载后安装目录、注册表与快捷方式无残留，安装版记录的 40 个进程全部退出。原用户配置、
设备及备份共 19 个 JSON 文件的 SHA256 全部不变。详见
[安装验收报告](packaging/acceptance.md) 与 `packaging/installation-result.json`。

独立干净 Windows 和物理断网测试未执行，不以开发机 PATH 限制与离线软件源设置替代。
没有向真实硬件发送测试操作，也没有转换用户当前工程；现场真实硬件联调仍需实际设备。

使用说明见 [应用搭建文档](../../docs/applications.md) 与
[SDK 文档](../../python/src/hardwareharness/README.md)。
