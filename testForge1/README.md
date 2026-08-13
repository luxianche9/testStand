# TestForge

TestForge 是面向硬件测试与实验室自动化的 Electron 桌面应用。它把设备目录、工程、接线、测试编排、MCP 工具和 Agent 接入放在同一个本地工作流中，同时用明确的包边界隔离领域逻辑与桌面运行时。

当前版本采用 8 个私有 source-first workspace 包，以及一个作为 composition root 的 Desktop 应用：

- `@testforge/contracts`
- `@testforge/storage`
- `@testforge/devices`
- `@testforge/projects`
- `@testforge/wiring`
- `@testforge/orchestration`
- `@testforge/application`
- `@testforge/mcp-gateway`
- `@testforge/desktop`

本阶段保持既有工程、设备和设置文件格式不变；SQLite、多用户中央控制面、Edge Agent 与 UI 视觉重做不在当前范围内。

## 快速开始

需要 Node.js、仓库声明的 `pnpm@10.15.0`，以及 Windows 桌面环境。Python MCP 模板需要 Python 3.10 或更高版本。

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

常用检查：

```powershell
pnpm verify       # 类型、lint、TS/Python 测试、边界检查和生产构建
pnpm verify:full  # verify + Electron E2E
```

生成可独立复制的 MCP Server 模板 ZIP：

```powershell
pnpm package:templates
```

产物位于 `output/mcp-templates/`，每个 ZIP 均包含模板本身和公共 runtime。

## 文档

- [当前架构与包职责](docs/architecture.md)
- [开发、构建与验证](docs/development.md)
- [安全部署与授权模型](docs/security.md)
- [架构决策记录](docs/adr/)
- [硬件手册索引](docs/hardware-manuals/README.md)

MCP 模板说明分别位于 [C/C++ SDK 模板](mcp_templates/c_server/README.md) 和 [VISA/SCPI 模板](mcp_templates/visascpi_server/README.md)。
