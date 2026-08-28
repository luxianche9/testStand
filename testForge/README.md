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

对外导出的 Run 日志继续使用 `TestRunLogArchive formatVersion: 1`。工程清单当前写入 `formatVersion: 3`，打开 v1/v2 清单时会先完整校验、逐版本升级，再以原子写入方式持久化。SQLite、多用户中央控制面、Edge Agent 与 UI 视觉重做不在当前范围内。

## 快速开始

需要 Node.js、仓库声明的 `pnpm@10.15.0`，以及 Windows 桌面环境。

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

常用检查：

```powershell
pnpm verify       # 类型、lint、测试、边界检查和生产构建
pnpm verify:full  # verify + Electron E2E
```
