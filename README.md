# testStand

单机测试台架软件：测试终端和全部测试资源运行在同一台 Windows 电脑上。Electron 桌面应用负责界面，Python 后端负责设备、测试计划、运行、判定与报告；每台设备是后端加载的插件，通过设备包（`.tsdev`）添加。

当前版本见 [CHANGELOG.md](CHANGELOG.md)。

## 架构

```
Electron 桌面应用（app/apps/desktop）
  渲染进程（React）：测试台架一个界面（活动栏切换设备管理/接线日志/测试编排/运行历史侧栏，右侧在运行监控和工位接线之间切换，工位接线又分针脚列表和端口连线）+ Agent 面板
  主进程：启动 Python 后端（stdout 一行握手 {port, token}，关闭 stdin = 退出）、窗口、原生对话框
        │  HTTP /api/ops + SSE（127.0.0.1，单 token）
        ▼
Python 后端（app/python，teststand_backend）
  HTTP API │ Agent MCP 网关（127.0.0.1:8000）
  设备清单 · 计划 · 运行 · 判定 · 报告 · OpenCode Agent 进程管理
  设备宿主：加载设备插件（devices/sdk + devices/adapters/*），进程内或隔离子进程
```

详细设计见 [doc/testStand设计.md](doc/testStand设计.md)，入门教程见 [doc/基础概念与架构教程.md](doc/基础概念与架构教程.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `app/apps/desktop` | Electron + React 桌面应用（electron-vite） |
| `app/packages/contracts` | 前后端共享的 TypeScript 契约 |
| `app/python` | Python 后端 `teststand_backend`（uv 管理） |
| `app/scripts` | 构建、校验、发布脚本 |
| `devices/sdk` | 设备插件 SDK `teststand_device_sdk` |
| `devices/adapters` | 四个板卡适配器：PCI-1710L、PCI-1762、PCI-6208V、CP-118U-I |
| `devices/native` | DAQNavi 桥接程序（`hwcli_*.cpp`） |
| `devices/pack.py` | 生成 `.tsdev` 设备包 |
| `skill/` | 编写设备插件等的 Agent 技能 |
| `doc/` | 设计文档、计划、调研 |

## 环境要求

- Windows 10/11 x64（桌面应用和设备驱动仅支持 Windows）
- Node.js 22 LTS 或更高
- pnpm 10（`corepack enable` 或 `npm i -g pnpm`；版本以 `app/package.json` 的 `packageManager` 为准）
- Python 3.11（`>=3.11,<3.12`）
- [uv](https://docs.astral.sh/uv/)

> 依赖必须用 **pnpm** 安装。工作区依赖（`workspace:*`）和 `app/patches/` 中的补丁只有 pnpm 能处理，不要在 `app/` 下运行 `npm install`。

## 安装依赖

```powershell
cd app
pnpm install          # Node 依赖（含 Electron 二进制）
pnpm python:setup     # = uv sync --project python --frozen，创建 app/python/.venv
```

开发环境中四个适配器以 editable 方式装进后端的虚拟环境。设备只驱动真实硬件，需要装好对应板卡和厂商驱动。

## 启动（开发模式）

```powershell
cd app
pnpm dev
```

会启动 electron-vite 开发服务器和 Electron 窗口；主进程用 `app/python/.venv/Scripts/python.exe -m teststand_backend.host` 拉起后端。

可选环境变量：

| 变量 | 作用 |
|---|---|
| `TESTSTAND_GATEWAY_PORT` | Agent MCP 网关端口，默认 `8000` |
| `TESTSTAND_BACKEND_EXECUTABLE` | 改用已打包的后端可执行文件 |

## 常用命令

在 `app/` 下运行：

| 命令 | 作用 |
|---|---|
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` | ESLint |
| `pnpm test` | 前端单元测试（vitest） |
| `pnpm test:e2e` | 端到端测试（Playwright） |
| `pnpm verify:python` | 后端 ruff / mypy / pytest 等检查 |
| `pnpm verify` | 前端全部检查 + 生产构建 |
| `pnpm verify:full` | `verify` + `verify:python` + `test:e2e` |
| `pnpm package:win` | 打包 Windows 安装程序 |
| `pnpm release` | 发布流程（输出到 `/release/`） |

## 设备包

发布版不内置任何驱动，在测试台架页“+ → 添加设备…”选择 `.tsdev` 设备包即可添加设备。生成设备包：

```powershell
cd devices
python native/build.py   # DAQNavi 桥接程序（需要 MinGW-w64 g++），pci1710l、pci1762 需要
python pack.py --all     # 测试 + 检查 + 打包 -> dist/*.tsdev
```

编写新的设备适配器见 [devices/README.md](devices/README.md) 和 [skill/device-plugin](skill/device-plugin/SKILL.md)。
