# 功能删除与架构检查（2026-09-16）

本次删除测试编排和运行日志整个功能链：页面、导航、脚本编辑器、流程定义、运行器、运行记录、专用 Python SDK、桌面 IPC、Agent 工具、打包资源及专用测试。设备服务诊断日志仍用于排障；Agent 对话和硬件直接调用继续提供。工程内用户已有脚本、日志和备份不做删除或执行。

旧 `applications`、`logs`、`orchestration` 页面设置统一回退到工位接线，保留其余设置。删除了无调用方的 CodeMirror 直接依赖及虚拟列表依赖、旧页面截图与交付产物。验证和截图输出移到忽略的 `output/`。

## 已处理的架构问题

- **业务生命周期耦合**：项目切换原本强制依赖脚本运行器的关闭和重建；删除运行器后解除该依赖，项目仍串行切换并处理接线会话恢复。
- **跨功能依赖**：网关脱敏原本借用运行日志模块。现在由网关自身的 `redaction.py` 提供，保留递归脱敏及不修改原对象的行为。
- **组件归属错误**：只由设置页使用的 `AgentIntegrationPage` 从 Agent 功能目录迁到设置目录，补齐设置与手动调用的依赖边界检查。
- **失效契约及版本分散**：删除 TS/Python 两侧旧事件和运行状态，统一公开契约版本位置，参考资料无需再依赖已删除的 SDK 或网关初始化。
- **测试依赖可删除报告**：旧 Python 门禁依赖 `reports/` 中交付快照；该目录被并行删除后普通测试也无法运行。当前门禁改为源码 lint、格式、严格类型、功能测试和独立覆盖率配置。保留模块的行/分支覆盖率阈值按原分数原样迁移到 `python/coverage-baseline.json`，参考资料模块仍要求 90%；移除旧阶段文件冻结和原 TS 测试映射门禁，保留源内契约 golden 测试。

## 建议后续重构

| 优先级 | 位置与问题 | 建议与验证边界 |
| --- | --- | --- |
| 高 | `packages/contracts/src/desktop.ts`、`main/ipc.ts`、`preload/api.ts`、Python `contracts/desktop.py` 和 `host/runtime.py` 手工维护同一组路由；本次需要逐层删除，历史事件枚举也已有漂移。 | 定义一份跨语言路由/事件描述，生成名称、参数和类型；保留真实 TS → Python 参数绑定测试，业务处理函数仍手写。避免只生成类型却留下独立运行时校验。 |
| 高 | `application/services.py::DevicesApplication.call_tool` 与 `application/control.py::ManualControlApplication.invoke_tool` 分别实现执行占用、取消、工具可用性和错误处理。Agent 路径另有只读元数据例外，策略容易分叉。 | 抽出共同的硬件执行服务，明确区分状态查询和有副作用的调用；由桌面与 MCP 适配器负责上下文和输出格式。先固定同设备冲突、跨设备并行、取消结果未知和元数据读取测试。 |
| 中 | `HardwareHarnessApplication` 使用 `dict[str, Any]` 注入，网关处理器大量使用 `Any`，Host 通过字符串和反射分发；严格 mypy 无法检查这些边界的真实形状。 | 按设备、工程、接线定义小型 `Protocol`/依赖数据类，逐步替换动态 mock。保留运行时路由白名单，类型重构不扩大公开接口。 |
| 中 | `useHardwareHarnessEvents` 和 `ManualInvokePanel` 重复订阅同一 dashboard 事件；`queries.ts` 的轮询与根级定时刷新也分别维护。 | 统一缓存失效与兜底轮询策略，页面只消费查询；用事件突发测试验证请求合并和切换工程时缓存隔离。 |

以上建议未做大规模实现，以便本次功能删除仍可独立审查。共享数据传输、设备驱动、接线算法及真实硬件行为仍应分别做针对性验证；模拟 MCP 验收不等同于物理硬件验收。

## 验证结果

- `pnpm verify` 通过：类型、lint、208 个 TypeScript 测试、模块依赖边界与生产构建。
- `pnpm verify:python` 通过：Ruff、格式、严格 mypy、766 个 Python 测试及保留模块原有覆盖率门槛。
- 完整 Playwright 端到端测试 30 项通过，覆盖设备调用、Agent 直接调用、设置导航、接线交互、窗口恢复和 9 组主题/尺寸场景。
- `git diff --check` 通过。未验证安装包或真实物理硬件。
