# ADR-0001：保持 source-first 分层 monorepo

状态：已接受

TestForge 继续使用私有 source-first workspace 包，并由 Desktop 作为唯一 composition root。contracts 零 workspace 依赖，领域包不依赖 Electron，IPC 只能依赖 application 与 contracts。

这样可让领域测试在无 Electron 环境运行，并用 dependency-cruiser 静态阻止边界回退。代价是新增跨层功能需要显式扩展 contracts/application，而不能从 renderer 直接调用具体服务；这是有意保留的约束。
