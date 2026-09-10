# devices / mcp-gateway 移植记录

本组已先逐条迁移原 Vitest 规格：devices 30 个展开用例、mcp-gateway 11 个用例，共 41 个。pytest 的 `ts_case` 标记保留原文件名和用例名。补充设备生命周期、真实 HTTP MCP、取消、重连、文件错误、ZIP、AJV 和网关协议差分后，本组 185 个用例全部通过。

以下三项是已获准修复的原 TS 缺陷；其他已发现的移植偏差均按 TS 行为修正。

## 1. 非法过期时间可以绕过 occupancy 租约检查

- 原位置：`packages/devices/src/hardware-occupancy.ts:46`、`:51`、`:87`、`:127`、`:135`。
- 原行为：remote 返回本客户端 holderId、`state: "occupied"`、`expiresAt: "not-a-timestamp"` 时，acquire/heartbeat 只检查字段非空。`Date.parse` 得到 NaN，`isHeld` 为 false，`requireLease` 的 `NaN <= Date.now()` 同样为 false，因而仍会返回 leaseId；心跳失败也不能按该值标记过期。
- 复现入口：human occupancy acquire 收到上述 remote 结果，随后经 aggregated hardware tool 调用进入 `requireLease`。该结果无需通过带有限制的远端 outputSchema。
- 修复：Python acquire/heartbeat 拒绝不可解析或类型不正确的过期时间；require_lease 明确拒绝非有限时间值。有效但已过期的 epoch 时间仍可按原行为记录，使用前检查会拒绝。
- 回归：`tests/devices/test_regressions.py::test_invalid_remote_expiry_never_grants_lease`、`::test_valid_epoch_lease_can_be_reported_but_cannot_be_used`、`::test_lease_heartbeat_release_and_expiry`。

## 2. 从公开图片和 bundle 接口修改定义后，catalog 仍返回旧端口数据

- 原位置：`packages/devices/src/device-catalog-service.ts:58`；`packages/application/src/devices-application.ts:112`、`:132` 的图片和 bundle 操作经 DeviceStore 写入。
- 原行为：端口索引签名仅含 hardwareId/portId。索引建立后，通过 `application.devices.setHardwareImageBytes`、`removeHardwareImage` 或 `importBundle` 修改图片、pin 或端口名称，身份未改变时会继续使用旧索引；图片 warning 和接线 pin 校验据此产生旧结果。普通 `catalog.saveHardware` 自带失效机制，因此缺陷复现使用上述公开直写路径。
- 修复：端口索引签名覆盖实际硬件定义；身份不变而内容改变时同步刷新缓存。
- 回归：`tests/devices/test_regressions.py::test_public_store_import_and_image_invalidate_catalog` 通过真实 `DevicesApplication` 调用图片和 bundle API，验证 warning、pin 名称和索引即时更新。

## 3. SSH 多字节输出超过声明的字节上限

- 原位置：`packages/devices/src/ssh.ts:138`、`:139`。
- 原行为：以 `Buffer.byteLength` 判断超限，却以 JavaScript UTF-16 `slice(0, maxBytes)` 截断。64 KiB 上限下，连续中文字符仍可能保留 65,536 个字符，即约 192 KiB UTF-8 数据。
- 修复：stdout/stderr 分别按 UTF-8 字节限制截断，并去除截断边界的不完整编码；exitCode、durationMs、truncated 语义保留。
- 回归：`tests/devices/test_regressions.py::test_ssh_output_cap_is_utf8_bytes`、`tests/devices/test_transports.py::test_ssh_drain_fingerprint_and_connection_config`。

## 归档 Python 实现的参考位置

- `E:/Project/归档/hardwareHarness/packages/host/src/hharness_host/mcp_bridge/__init__.py`：采用其会话与 `AsyncExitStack` 生命周期方式，使 MCP HTTP context、ClientSession 和清理在同一个 owner task 内完成。
- `E:/Project/归档/hardwareHarness/packages/plugins/src/hharness_plugins/ssh/__init__.py`：参考 Paramiko 连接、双通道 stdout/stderr 排空、退出码、超时及关闭流程，移植现 TS SSH manager 对外行为。
- `E:/Project/归档/hardwareHarness/packages/core/src/hharness/core/client.py`、`packages/host/src/hharness_host/plugin.py`、`packages/host/src/hharness_host/app.py`：参考 claim/renew/释放生命周期；当前协议保留 `testforge_hardware_occupancy` 的 status/acquire/heartbeat/release、UUID holder/lease 标识、5 秒 heartbeat 和原通知行为。
- `E:/Project/归档/HHarness/packages/hharness-kernel/src/hharness_kernel/leases/service.py`：参考 human 占用与运行期间使用之间的职责划分；存储和对外占用结构沿用本次 TS 规格。

## 已修正的 SDK 和文件边界差异

网关在 Python MCP SDK 前保留 TS 的 loopback/Host/Origin/token 判定、1 MiB body 上限、严格 JSON-RPC envelope、HTTP error 的 id/code/message、单次 initialize、未知 method、历史 protocolVersion、batch 和空 batch 语义。成功工具结果省略 SDK 默认插入的 `isError: false`，initialize capabilities 精确返回 `{ "tools": {} }`。失败 initialize 及时清理 session；取消 MCP 请求保留原 TS handler 的应用操作持续执行行为。

`python/tests/mcp_gateway/protocol-oracle.cjs` 直接加载未改动的原 TS 源码，产生 `protocol-golden.json`。其 17 组 HTTP golden 全部通过；`test_boundaries.py` 另覆盖全部 29 个内置工具的路由/默认值、Zod issues、嵌套对象字段剥离、权限、图片和 token 持久化失败。

客户端保留 TS 的五次指数重连、server retry/Last-Event-ID、初始 GET 不支持时的行为、timeout/AbortSignal cancellation requestId，以及 close 不发送 DELETE 的行为。AJV errorsText 和格式检查有 29 组原 TS 金样本及扩展测试；内置工具 schema/description 来自原定义的完整快照。

DeviceStore 复用 `compat.filesystem` 的 Node/libuv 错误语义，保留 JSON 文本、LF 结尾、UTF-8 replacement/BOM 解码差异及 manifest 检查顺序。ZIP 导入按原 fflate 的本地记录读取方式工作，兼容没有 central directory 的数据，并保持原 CRC 行为。文件/ZIP 的新增差异都有等价断言；已发现的协议差异均已修正，没有将这些差异列作额外例外。

## 验证结果

- 本组：`185 passed in 12.47s`。
- `ruff check`、`ruff format --check`、`mypy strict`：通过，25 个 Python 文件。
- devices 行覆盖 `1432/1524 = 93.963%`，分支 `419/512 = 81.836%`；原 TS 基线分别为 `63.77% / 72.01%`。
- mcp-gateway 行覆盖 `392/409 = 95.844%`，分支 `109/122 = 89.344%`；原 TS 基线分别为 `92.55% / 78.62%`。
- 最终全量门禁：`pnpm verify:python`，`817 passed in 26.86s`，日志见 [python-final-verify.txt](python-final-verify.txt)。所有八包行与分支覆盖率均通过原 TS 基线门槛。
- 本组未改 renderer、main/opencode 文件或现有样式；Electron/main 和安装包的最终验收见 [交付报告](implementation.md)。
