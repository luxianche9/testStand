# ADR-0003：本地 Gateway 使用 capability 白名单

状态：已接受

MCP Gateway 仅监听回环地址，通过受保护的 bearer token 验证客户端，并按 RequestContext capability 生成和执行工具。Gateway token 永不下发 renderer。

Agent 只获得完成自动化所需的最小能力。接线变更必须生成人工任务，Agent 不能确认物理动作；注册主机、任意 SSH 和强停服务永久不在白名单。即使工具目录被错误展示，application authorizer 仍会在执行时再次拒绝越权请求。
