# HardwareHarness

本目录是应用工作区。从仓库根目录运行命令前，请先执行 `cd HardwareHarness`。
产品与接口已统一改名；旧名称的字段、环境变量、工程路径及文件扩展名不再兼容。
详见 [改名验证记录](reports/rename/README.md)。

HardwareHarness 是面向硬件测试与实验室自动化的 Electron 桌面应用。它将设备目录、接线、Python 流程、Web 应用和 Agent 放在同一个工程中。

当前版本由 Python 后端、`@hardwareharness/contracts` 纯契约包和 Electron Desktop 应用组成。
main 启动单个 Python 子进程，通过私有 stdio JSON-RPC 转发业务请求；设备、存储、
工程、接线、应用运行和对外 MCP 由 Python 持有。七个旧 TS 业务包已删除，原测试规格、
覆盖率基线和 golden fixtures 保留为历史证据。

renderer 使用 shadcn New York / neutral 主题，保持原有业务流程。Electron 平台接口、
OpenCode 集成及其依赖补丁沿用现状。详见 [本阶段交付报告](reports/shadcn/implementation.md)
和 [shadcn 来源与适配说明](docs/shadcn/README.md)。

“应用搭建”提供文件树、Python/Web 编辑器、诊断、内嵌 FastAPI 页面及结构化运行记录。
内置 `hardwareharness` 库只提供主动硬件调用和日志；Agent 和平台负责接线、占用与人工确认。
工程清单使用 v4。打开旧工程时先验证原始备份，再移除节点任务；旧 Run 仅作为备份保存，
不再由界面读取，也不会恢复或重放旧节点。详见 [应用搭建使用说明](docs/applications.md)。

## 快速开始

开发需要 Node.js、仓库声明的 `pnpm@10.15.0`、uv 和 Windows 桌面环境。
安装包自带 Python 后端，目标机器无需 Python 或 uv。

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm python:setup
pnpm build:project-runtime # 默认应用所需的 SDK、Python、uv 和离线依赖
pnpm dev
```

常用检查：

```powershell
pnpm verify       # 类型、lint、测试、边界检查和生产构建
pnpm verify:python # ruff、mypy strict、pytest、原规格/覆盖率/保护文件检查
pnpm verify:full  # verify + Python 门禁 + Electron E2E
pnpm test:coverage
pnpm package:win  # Python onedir + Windows x64 安装包
```
