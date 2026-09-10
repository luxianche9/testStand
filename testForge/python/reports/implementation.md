# 8 个 TS 包的 Python 移植交付记录

已在 `testForge/python` 实现 contracts、storage、devices、projects、wiring、orchestration、application、mcp-gateway，并接入 Electron main。main 启动单个 Python 子进程，以私有双向 stdio JSON-RPC 转发业务调用；renderer 的 electron-trpc facade、订阅和 preload transformer 保持原接口。原八包 TS 源码及测试保留作对照，生产 main 不再执行七包 TS 业务实现，contracts 继续供 TS 类型和运行时校验使用。

本机源码、冻结程序和最终安装包检查均通过。**独立、断网、未安装 Python/uv 的干净 Windows 虚拟机验收尚未执行**；本次实际完成的是本机隔离 PATH、清除 Python 环境变量、只读安装目录的安装运行验证。不能把这些结果表述为已完成干净虚拟机验收。

## 最终门禁与证据

| 检查 | 结果 | 保存的证据 |
| --- | --- | --- |
| 原八包 Vitest 基线 | 18 个文件，117 个展开用例通过 | [原始结果](ts-packages-results.json)、[基线日志](ts-packages-baseline.txt)、[原始覆盖率](ts-packages-coverage.json) |
| Python 独立门禁 `pnpm verify:python` | ruff check、format check、mypy strict 全通过；817 pytest 通过 | [完整日志](python-final-verify.txt)、[pytest 结果](python-spec-results.json) |
| 原规格逐条映射 | 117/117 有通过的 Python 对应测试；原文件哈希和断言清单未失效 | [完整用例名与双方断言](specification-map.json)、[原断言库存](ts-assertion-inventory.json) |
| Python 分支覆盖率门禁 | 八包行和分支比例均达到原 TS 基线 | [逐包计数](coverage-comparison.json)、[逐行与分支原始数据](python-coverage.json) |
| TS `pnpm verify` | 类型、lint、322 tests、依赖/导入边界、knip、生产构建通过 | [完整日志](ts-final-verify.txt) |
| TS `pnpm test:coverage` | 58 个文件、322 tests，通过原覆盖率门槛 | [覆盖率日志](ts-final-coverage.txt) |
| PyInstaller onedir | 最终 Windows x64 后端构建成功 | [构建日志](frozen-build.txt) |
| 最终冻结后端的真实进程测试 | 5/5 通过；隔离 PATH 与 Python 环境变量 | [结果](frozen-isolated-tests.txt)、[测试源码](../tests/host/test_process.py) |
| 最终冻结后端的完整 Electron E2E | 13/13 通过，包含原有 12 项 | [完整结果](electron-frozen-e2e.txt) |
| NSIS 最终安装包 | 构建成功；只读、中文及空格安装路径运行通过 | [打包日志](windows-package.txt)、[安装运行结果](windows-installed-acceptance.txt) |
| 保护文件 | 152 项通过，仅使用用户授权的 LogsPage 例外 | [原哈希](protected-files.json)、[例外前后哈希](protected-exceptions.json) |

817 是 Python 全套用例数；冻结程序的 5 项是同一组进程测试的另一次运行，不另加到 817。322 个 TS 用例包括原八包的 117 项和 desktop 的 205 项。mypy strict 检查源码与测试，共 98 个文件；ruff 检查源码、测试和脚本，共 105 个文件。Python pytest 开启 asyncio auto 与分支覆盖。

原始 `pnpm verify` 的 LogsPage hooks lint 失败保存在 [基线日志](ts-baseline-verify.txt)。[首次 workspace 覆盖率尝试](initial-workspace-coverage-attempt.txt) 保留了依赖未安装完整和超时的失败证据，其中已经包含早期新增的 transport 测试，不能用它替代原八包基线或最终验收结果。最终权威日志是上表列出的成功结果。

## 行为、断言和差分

测试映射保存原完整 Vitest 名称、原断言与行号、pytest nodeid 以及对应 Python 断言；包括参数化展开、原循环断言和跨包规格。contracts 的 TestStep 静态用例使用递归 TypedDict union 与 mypy 正反声明，覆盖全部八种 step。每组先迁移原测试，再实现对应行为；新增差分和边界测试补足 Python/JS、SDK、文件系统及进程边界。

差分的期望来自未修改的 TS 或 Electron 内的 Node API，作为已保存的 golden fixtures 随 pytest 执行。它们不是由 Python 实现生成的自比较结果。已保留：229 组 Zod/契约输入（含 70 个 URL 边界），4 组 storage 和 2 组 wiring 的逐步返回/事件/磁盘字节，15 组 Windows 文件系统错误，127 组 V8 JSON 错误，17 组 MCP HTTP 协议，以及 AJV、所有 29 个内置 MCP 工具和 facade 调用规格。78 个 TS facade procedure 逐一检查转发参数；Python 以同一套调用 fixture 校验真实控制器签名，并覆盖内部接线方法。

| 包 | 原 TS 行 / 分支 | 最终 Python 行 / 分支 |
| --- | ---: | ---: |
| contracts | 89.90% / 80.95% | 96.44% / 94.52% |
| storage | 93.13% / 82.96% | 99.29% / 93.62% |
| devices | 63.77% / 72.01% | 93.96% / 81.84% |
| projects | 92.50% / 71.21% | 96.36% / 80.77% |
| wiring | 77.11% / 65.57% | 99.38% / 94.64% |
| orchestration | 85.20% / 77.07% | 96.21% / 91.06% |
| application | 67.12% / 86.03% | 99.23% / 97.50% |
| mcp-gateway | 92.55% / 78.62% | 95.84% / 89.34% |

两种覆盖工具统计的语法单元不同，比例门禁只能与原断言映射和差分证据共同使用；这些数值不表示全程序已达到 100% 覆盖率，也不构成对全部可能输入的形式化等价证明。

磁盘兼容、工程 v1→v2→v3、默认值/未知字段/null、JSON/JSONL、Run archive/XState snapshot、原子与队列写入、文件错误及中文排序详见 [文件与契约兼容报告](compatibility-storage.md)。全局旧 SQLite 迁移也已移入 Python，保留原部分发布失败行为；有效 v3 工程只打开不重写，未来及损坏清单拒绝后保留原字节。

设备实现参考归档的 mcp_bridge、Paramiko SSH 和租约生命周期。MCP SDK 的关闭不额外 DELETE、超时取消与重连、输出校验、网关 Host/Origin/Bearer/状态码与限制等适配，以及 bundle/ZIP 和 SSH 证据详见 [设备与网关兼容报告](compatibility-devices-gateway.md)。原权限矩阵和包默认/desktop 覆盖超时保留，硬件调用不会自动重放。

编排测试覆盖步骤/事件顺序、互斥、重试、确认、失租约取消、独立 cleanup 取消域和恢复。真实进程测试强制结束后端后重开工程，确认 Run 恢复、已完成步骤不重放，取消后的 cleanup 看到最新 checkpoint 变量。main 的成功及失败响应均先更新内部状态快照，测试包含持久化部分失败、token 可见性和 cleanup 失败时仍回收子进程。

内部传输保留 undefined、Uint8Array、Date、NaN/infinity/-0 及对象形状；stdout 专用于协议。safeStorage 反向 RPC 由独立读线程完成同步等待，保留按需解密报错时机；实际 Electron 旧密文重开验证通过。main 继续持有窗口、对话框、图片协议与现有 Agent/OpenCode 集成，Python 唯一持有业务状态和存储。

## 边界与七项批准的修正

renderer 唯一改动是用户单独授权的 `LogsPage.tsx`：将空数组默认值移入 useMemo 并修正依赖。其余 renderer 文件、全部 `main/opencode-*.ts`、react-opencode 依赖/补丁和 OpenCode 二进制依赖的保护检查均通过。原八包 TS 源码与测试没有改动。

七项业务修正分别是危险 Run 路径、过期 occupancy 请求、非法租约到期时间、checkpoint 上下文、设备缓存、危险变量路径的校验返回、SSH UTF-8 字节上限。每项的原行为、复现、不照抄理由和回归 nodeid 单独列在 [七项缺陷偏差报告](bug-deviations.md)，没有把其他发现的移植差异增列为例外。

为恢复已有门禁，还补了原 renderer helper 的外部测试以满足 knip；把 welcome-preview E2E 的旧颜色期望修正为 Git 基线已有颜色；启用 esbuild 压缩，使原有 1 MB renderer 入口门槛通过（894,620 bytes）。页面和样式未随这些调整改变，门槛未降低。desktop 中只供原 TS 测试/构建使用的 workspace 包移到 devDependencies，其余已不用的业务包依赖移除，原包本身保留。

## 安装产物与复现

最终安装包：[TestForge-0.1.0-windows-x64.exe](../../dist/TestForge-0.1.0-windows-x64.exe)，223,234,345 bytes。

SHA256：`066fd83f62df15cbd1295727c63f424ec681ceb1055943948c9d0bac755635e2`。

冻结后端：[testforge-backend.exe](../dist/testforge-backend/testforge-backend.exe)。发布需保留整个 onedir 目录，安装器已包含它。Python 3.11.15、ICU 74.2、Ada 2.9.2 与所需扩展一并交付；Ada URL wheel 锁为 1.15.3。打包后的全部 254 个后端文件与最终冻结输出逐项 SHA256 一致，版本、大小及哈希见 [产物清单](artifact-manifest.json)。

最终安装测试使用 workspace `dist/安装 验收`，通过实际 ACL 拒绝写入并验证拒绝有效。应用仅使用 System32 PATH，清除 Python 环境变量和后端开发路径覆盖；启动、旧 OS 密文读取与重开、正常退出后无后端残留均通过。测试后恢复 ACL 并卸载临时安装；未留下 TestForge 安装记录或运行进程。未执行独立干净 Windows 虚拟机或实际断网验证。

从 `testForge` 执行：

```powershell
pnpm install --frozen-lockfile
pnpm python:setup
pnpm verify:full
pnpm test:coverage
pnpm package:win
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify-installed.ps1
```

安装验收脚本会拒绝覆盖不属于该 workspace 验收目录的现有 TestForge 安装，默认卸载它创建的临时安装。冻结程序单独验证命令及开发入口见 [Python README](../README.md)。本次未创建 Git 提交。
