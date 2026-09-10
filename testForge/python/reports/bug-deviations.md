# 七项经用户批准的行为差异

这些是本次允许改变的七项业务行为。其余与原 TS 的差异按移植缺陷处理，原 TS 源码和测试保留。

| # | 原 TS 位置与复现 | 原行为 / 不照抄的理由 | Python 行为与回归 |
|---|---|---|---|
| 1 | `packages/storage/src/run-log-store.ts` 的 Run 路径构造及删除；在合法历史目录中的 `run.upsert` 中构造 `runId: "."` 或 `".."`，再经删除历史操作调用 | ID 进入目录拼接，可能删除整个 runs 或日志目录；正常 UUID 生成不会主动产生这些 ID，但加载的历史可触发 | 在所有 Run 路径操作前拒绝危险 ID，父目录及兄弟 Run 保留。`tests/storage/test_run_log_store.py::test_dot_run_never_operates_on_parent[.]`、`[..]` |
| 2 | `packages/application/src/hardware-occupancy-application.ts`；请求过期后，尚未执行列表刷新时读取旧请求并确认 | 仍可能使用 pending 对象确认过期授权 | 首次读取即转 `timed_out`；acquire/reject/reconcile 不再确认。`tests/application/test_regressions.py::test_expired_occupancy_never_confirms` |
| 3 | `packages/devices/src/hardware-occupancy.ts:49`；远端返回 `expiresAt: "invalid"` | `Date.parse` 为 NaN，`NaN <= now` 为 false，`requireLease` 放行，没有有效期限的授权可使用 | 拒绝非法期限，过期租约不可调用。`tests/devices/test_regressions.py::test_invalid_remote_expiry_never_grants_lease` |
| 4 | `packages/orchestration/src/run-lifecycle.ts:332` 及 interpreter；主流程连续设置 `x=1`、`x=2`，cleanup 断言 `x==2`，中途保存 checkpoint | checkpoint 替换 `active.context`，interpreter 后续写入仍指向旧对象，cleanup/恢复会读到过期变量 | 运行上下文保持同一权威对象，checkpoint 只复制持久化快照。`tests/orchestration/test_regressions.py::test_checkpoint_latest_context_cleanup_and_recovery` |
| 5 | `packages/devices/src/device-catalog-service.ts` / `device-store.ts`；先 resolve port，导入相同 hardware/port ID 的新 pins 或修改图片，再 resolve | 原 catalog 缓存未随导入/图片写入失效，后续接线验证看到旧 pins/图片；原正常 `saveHardware` 已失效，不属于这个缺陷 | 缓存签名覆盖完整硬件定义，相关写入改变内容时刷新解析结果。`tests/devices/test_regressions.py::test_public_store_import_and_image_invalidate_catalog` |
| 6 | `packages/orchestration/src/workflow*.ts` 的变量路径静态检查；校验包含 `x.constructor` 等危险路径的工作流 | 校验入口直接抛出异常，没有返回 `TaskValidationResult`，调用方无法展示既有 issue | 返回 `unsafe_variable_path` validation issue，运行时仍拒绝危险访问。`tests/orchestration/test_regressions.py::test_unsafe_validation_returns_issue` |
| 7 | `packages/devices/src/ssh.ts:138`；中文 stdout/stderr 超过 `maxBytes` | 先按 UTF-8 字节检查，再按 UTF-16 字符 `.slice(0,maxBytes)`；中文可达到声明字节上限的约三倍 | 按 UTF-8 字节截断并避免破坏字符，保留原 truncated 标记及每路输出上限。`tests/devices/test_regressions.py::test_ssh_output_cap_is_utf8_bytes` |

第 1 项只针对构造历史中的危险 ID，不声称正常 UUID 路径存在随机触发风险。第 4 项保留 XState snapshot 的磁盘形状，只修复其数据来源。其余特殊旧行为（例如非法 MCP JSON 的 HTTP 500、部分写入失败、原默认超时和原权限矩阵）仍按 TS 规格保留。

另有两项验收基线维护，不是业务缺陷例外：用户单独授权的 `LogsPage.tsx` hooks lint 修复，以及 E2E 的旧颜色断言改为 Git 基线已有的 `oklch(0.52 0.16 255)`。样式未改变。生产输出启用 esbuild 压缩以满足已有 1 MB 入口门槛，门槛未降低。
