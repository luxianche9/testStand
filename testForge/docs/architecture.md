# TestForge 架构

TestForge 是 pnpm monorepo。桌面应用是唯一的 composition root；领域包不依赖 Electron，也不反向依赖桌面代码。仓库通过 dependency-cruiser、导入边界脚本和 Knip 在 CI 中持续校验这些约束。

## 依赖方向

```text
contracts
├─ storage
├─ devices ─────┐
├─ projects ────┤
├─ wiring ──────┼─ application ── mcp-gateway
└─ orchestration┘          └────── desktop main/preload/renderer
```

- `contracts`：跨进程、跨包数据结构、Zod schema、错误类别和授权能力。
- `storage`：原子文件写入、设置、秘密与 append-only Run 日志。
- `devices`：设备目录、MCP 传输、远程 shell 和硬件包导入导出。
- `projects`：`.testforge/project.json` 生命周期和格式迁移。
- `wiring`：接线图纯领域逻辑及需要人工确认的接线任务。
- `orchestration`：XState Run 状态机、执行器、硬件 mailbox、cleanup 和恢复。
- `application`：授权后的用例入口；Desktop IPC 与 MCP Gateway 都通过这里访问领域能力。
- `mcp-gateway`：仅回环地址开放的 MCP HTTP 服务和 Agent 工具白名单。
- `desktop`：Electron composition、tRPC IPC、preload facade 与 React renderer。

## 运行时边界

Renderer 只访问 `window.testforge`。preload 保持 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，使用自定义 tRPC v11 Electron handler 将调用路由到 application 层。事件通过显式订阅通道广播，不在订阅前缓存。

设备访问由 `DeviceTransport` 和 `RemoteShell` 抽象承载。Windows 服务控制只是具体适配器能力，不进入通用 contracts。编排器按硬件 ID 串行化工具调用，run 之间再由执行协调器持有租约。

## 数据与恢复

- 设置和秘密写入由共享串行写入器排队，避免 read-modify-write 丢更新。
- 工程清单以原子替换写入；v1/v2 通过确定性的逐版本迁移升级为 v3。
- Run 内部日志使用每个 Run 一个 JSONL 流和周期性快照；损坏行被隔离并产生 warning。
- 外部导出格式 `TestRunLogArchive formatVersion: 1` 是稳定契约，不随内部持久化改变。

## 前端装载

Welcome、Settings、项目功能和 Agent 侧栏按路由或功能懒加载。生产校验要求入口 chunk 小于 1 MB，并要求 `assistant-*` 保持独立。长 Run 的节点与事件列表使用虚拟化，实时事件窗口默认保留最近 500 条。
