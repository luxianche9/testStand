# 安全与授权

TestForge 控制真实硬件。安全模型的首要目标是：失败、取消、进程退出和 Agent 调用都不能绕过物理安全边界。

## Electron

- Renderer 启用 sandbox 与 context isolation，关闭 Node integration。
- 新窗口一律拒绝；导航仅允许当前 renderer 文件或开发 origin。
- 所有 Electron permission request 默认拒绝。
- Renderer 只持有类型化 facade，不持有 Gateway bearer token、LLM API key 或 OpenCode 密码。
- 日志写盘前统一脱敏已注册的 token、API key 和运行时密码。

## 本地 MCP Gateway

- 只监听 `127.0.0.1`，校验 remote address、Host 和 Origin。
- Bearer token 存储在受操作系统保护的 SecretStore 中，并使用定时安全比较。
- 请求体上限为 1 MiB，超限返回 413。
- 首选端口被占用时回退到临时端口；启动失败只降级 Agent 功能，不终止桌面应用。
- 每个 MCP session 生成独立 request ID，并从 `clientInfo` 形成审计 subject。

Gateway 工具由 capability 白名单生成。Agent 可以请求人工接线任务，但不能确认接线；不能注册远程主机、执行任意 SSH、强停远程服务或调用未授权工具。所有实际调用再次经过 application authorizer，Gateway 列表不是唯一防线。

## 编排与物理安全

- cleanup 有总预算，超时会 abort，关闭应用不会无限等待。
- cleanup 中的 operator 步骤有独立超时，不能永久挂起。
- 桌面端显式使用 15 秒 cleanup 总预算和 3 秒 operator 超时；部署时可通过 `TESTFORGE_CLEANUP_BUDGET_MS`（1,000–120,000）与 `TESTFORGE_CLEANUP_OPERATOR_TIMEOUT_MS`（250–30,000）覆盖。非法值会回退到默认值，operator 超时不会超过总预算。
- 非幂等 tool 步骤最多执行一次；幂等重试携带 attempt 与 idempotency key，并只对配置的错误类别重试。
- 同一硬件的并行分支经 mailbox 串行化；首个失败会取消兄弟分支。
- run 之间通过执行租约互斥；终态优先级保持 `interrupted > cancelled > failed > passed`。
- 崩溃恢复优先从 XState snapshot 续跑；不能安全恢复时至少补偿执行 cleanup。

## 秘密与部署

不要把凭据写入工程清单、硬件 bundle、日志、测试 fixture 或 GitHub Actions 配置。生产环境必须让 Electron `safeStorage` 可用；无法使用操作系统凭据加密时，应用拒绝创建 composition，而不是退化为明文存储。

TestForge 不集成外部崩溃上传服务。日志和 Electron crash report 默认留在本机，实验室可按自身数据保留政策收集。

发现凭据泄漏时，应旋转 Gateway token 和相关外部服务凭据，清理本地日志副本，并审查 MCP session 的 subject/request ID。
