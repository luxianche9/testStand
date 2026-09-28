# 服务契约

后端、AI 网关和画布都只依赖这份契约。SDK 已经实现了除设备工具以外的全部内容；适配器保证设备工具的声明真实。

## 传输与进程

| 项 | 要求 |
|---|---|
| MCP | Streamable HTTP，路径 `/mcp`，`Authorization: Bearer <token>`；无令牌返回 401 |
| 健康检查 | `GET /health` 不需要令牌，返回 `{healthy, serverId, hardwareId, state, sdkVersion}` |
| 停机 | `POST /admin/shutdown`（需令牌）或内部工具 `hardwareharness_prepare_shutdown`：先 `safe_state`，拒绝新操作，然后退出 |
| 流 | WebSocket `/streams/{streamId}?from=<cursor或-N>`，同一令牌；只读，见 `streams-and-panel.md` |
| 一服务一硬件 | `list_hardware` 恰好一项，`hardwareId` 等于 `server.json` 登记值 |
| 启动 | `python -m hardwareharness_device_sdk --adapter hh_adapter_<adapter>`，配置由 `HARDWAREHARNESS_SERVER_CONFIG` 指向 `server.json` |
| dry-run | `HARDWARE_DRY_RUN=1` 或 `server.json` 的 `dryRun: true`；`executionMode` 报告 `nonphysical_driver_override` |

## 公共工具（SDK 提供）

| 工具 | 类型 | 说明 |
|---|---|---|
| `get_server_info` | read | 版本、就绪状态、`capabilities`、`sdkVersion`、`adapter`、`sourceRevision` |
| `list_hardware` | read | 唯一硬件及其生命周期状态 |
| `get_hardware_info(hardwareId)` | read | 状态 + `capabilityDetails`（SDK 通用字段 + 适配器 `capability_details()`） |
| `get_pinout(hardwareId, connector_id?, offset, limit?)` | read | 适配器 `pinout()`；未提供时返回 `not_supported` |
| `list_streams(hardwareId)` | read | 每个流的 `streamId/kind/label/unit/valueSchema/requires/state/epoch/head/tail/capacity`，采样流另有 `rateHz` |
| `get_panel(hardwareId)` | read | 控件模板 `{hardwareId, items[]}` |
| `<prefix>_stream_read(hardwareId, streamId, cursor?, max_items=200)` | read | 不消费地读缓冲；省略 `cursor` 取最新 `max_items` 条 |
| `<prefix>_stream_start(hardwareId, streamId, seconds=60)` | configure | 让采样流在无人观看时也采样，便于测试步骤收集历史 |
| `<prefix>_stream_stop(hardwareId, streamId)` | configure | 释放上面的保持 |
| `hardwareharness_prepare_shutdown` | internal | 仅供后端停服务，不给 AI 或测试步骤 |

## 设备工具（适配器提供）

- 命名 `<prefix>_<name>`，例如 `pci6208v_set_voltage`。第一个参数 `hardwareId` 由 SDK 自动加上。
- 每个工具的 `_meta.hardwareharness` 含 `kind: "hardware"`、`contractRevision`、`operationSemantics`；`kind="safe"` 的工具另有 `safeAction: true`。
- 注解：`read` → `readOnlyHint=true, idempotentHint=true`；其他 → `destructiveHint=true`。
- 描述不少于 80 个字符，说明它证明什么、不证明什么、失败后怎么办。

## 操作语义 `operationSemantics`

由 `@tool` 的参数生成，后端编排校验和执行引擎都依赖它：

| 字段 | 来源 | 含义 |
|---|---|---|
| `kind` | `kind=` | `read` / `configure` / `actuate` / `safe` |
| `retry` | 由 kind 推出 | `actuate` 为 `never_after_dispatch`，其余 `safe` |
| `stateRequirements` | `requires=` | 调用前必须成立的状态，例如 `analog_input_configured` |
| `stateEffects` | `effects=` | 调用成功后成立的状态，例如 `serial_port_configured`、`voltage_output_active` |
| `evidenceType` | `evidence=` | 默认 read 为 `controller_state`，其他为 `observation`；真实采样写 `measurement` |
| `safetyAction` | `safety_action=` | 调用后需要登记的恢复动作 `{toolName, arguments}`；短名自动加前缀，必须是已存在的工具 |
| `outcomeOnInvalidResponse` | 固定 | `unknown`：响应无效时视为结果未知，进入人工核销 |

状态名用小写蛇形，一个 `effects` 应该被某个 `requires` 用到，否则就不必声明。

## 结果信封

```json
{"ok": true,  "message": "", "data": {...}, "meta": {"timestamp": "2026-09-24T08:00:00+00:00"}}
{"ok": false, "error": {"category": "device_error", "message": "...", "retryable": false,
                        "details": {...}, "recovery": "..."}, "meta": {"timestamp": "..."}}
```

`data` 的结构由 `@tool(output=...)` 的模型决定，并出现在 `outputSchema` 里。适配器方法直接返回 `data` 的字典，SDK 负责包信封；抛 `DeviceError` 得到失败信封。

## 错误类别

| 常量 | 值 | 何时用 | `retryable` |
|---|---|---|---|
| `INVALID_ARGUMENT` | `invalid_argument` | 参数越界、组合非法；驱动未被调用 | 否 |
| `NOT_CONFIGURED` | `not_configured` | 前置配置缺失，如未 `configure_ai` 就读 | 否 |
| `DEVICE_ERROR` | `device_error` | 驱动返回错误码（默认类别） | 否 |
| `DEVICE_UNREACHABLE` | `device_unreachable` | 打开失败、设备未打开、CLI 不存在或退出 | 是 |
| `SERVICE_UNAVAILABLE` | `service_unavailable` | 服务正在停机 | 是 |
| `INVALID_RESPONSE` | `invalid_response` | 驱动或 CLI 的返回无法解析 | 否 |
| `NOT_SUPPORTED` | `not_supported` | 该型号不提供此能力（如引脚表） | 否 |
| `INTERNAL` | `internal` | 未预期的异常；SDK 会记录日志 | 否 |

`retryable` 只是传输层建议，永远不授权重放物理动作。写操作失败时 `details` 要带上 `requested`、已生效部分和最后已知状态。

## 生命周期

硬件状态：`initializing → open`；打开失败为 `unreachable`，看门狗按 5 s、10 s、30 s 重试；停止时 `closing → closed`，关闭失败为 `faulted`。只有 `open` 时设备工具可用，否则返回 `device_unreachable`。
