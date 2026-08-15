# 开发与验证

## 环境

- Node.js 22（CI 使用当前 Node 22）
- `pnpm@10.15.0`
- Windows 11 或等价 Windows 桌面环境，用于 Electron E2E 和打包烟雾测试

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

不要绕过 workspace 包边界从源码深路径导入。公共类型从 `@testforge/contracts/<subpath>` 引用；领域操作优先进入 application 层，再暴露给 IPC 或 Gateway。

## 常用命令

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
pnpm check:imports
pnpm check:dependencies
pnpm build
pnpm verify
pnpm verify:full
```

`pnpm verify` 是提交前最低门槛。它包含类型、lint、全部单元测试、导入/依赖治理和生产构建幂等检查。`pnpm verify:full` 额外运行 Electron Playwright E2E。CI 在 PR 与 push 上运行 verify 和覆盖率，定时任务运行 full 验证。

当前覆盖率最低阈值为 statements/lines 50%、branches 65%、functions 60%。阈值是防回退基线，不代表关键安全路径只需达到该比例；cleanup、授权、文件迁移和秘密处理的改动应补定向测试。

## 改动准则

- 新增 IPC procedure 时，同时更新 contracts、router、preload facade 与 facade 完整性测试。
- 新增 TestStep 字段或变体时，同时更新 Zod schema、MCP JSON Schema 和双向一致性 fixture。
- 新增设备传输时实现通用 transport 接口，避免在领域层添加平台判断。
- 修改工程格式时新增一个版本 schema 和一个单步升级函数；禁止直接跳过中间版本。
- 修改 Run 内部存储时保持外部 `TestRunLogArchive formatVersion: 1` 不变。
- Renderer 新共享组件使用 `styles.css` 中的显式类；Agent 目录外不要依赖 Agent Tailwind source 范围。

## E2E 测试说明

E2E 使用隔离的临时 `TESTFORGE_USER_DATA_DIR`。外部 MCP 客户端测试通过 `TESTFORGE_AGENT_INTEGRATION_TEST_MODE=1` 和 `TESTFORGE_GATEWAY_TEST_TOKEN` 注入测试令牌；生产代码不会把 Gateway 令牌暴露给 renderer。不要在非测试运行中设置这两个变量。
