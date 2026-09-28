# 流与面板

流让画布控件、AI 和测试步骤看到同一份实时数据；面板模板告诉画布"这台设备建议放哪些控件、各绑定什么"。控制永远走 MCP 工具，流只读。

## 数据通路

```
适配器 → Stream.buffer (RingBuffer, 带序号)
            ├─ WebSocket /streams/{streamId}   → Electron 主进程 StreamHub → 画布控件
            └─ MCP <prefix>_stream_read        → AI、测试步骤
```

条目格式 `{"seq": int, "t": UNIX 秒, ...}`。`seq` 从 0 单调递增；`tail` 是最老的保留序号，`head` 是下一个要分配的序号。读者用游标（序号）读，从不消费数据，所以任意多个读者互不影响。每次服务启动缓冲都有新的 `epoch`，游标只在同一 `epoch` 内有效。

## 三种流

| 类 | `kind` | 谁写入 | 典型用途 |
|---|---|---|---|
| `Stream` | `push` | 适配器在值变化时 `publish(value, **extra)` | 输出的软件影子：AO 最后写入值、DO 掩码 |
| `SampledStream` | `sampled` | SDK 按 `rate_hz` 调用 `sample()` | 模拟量读数、离散量位图、继电器回读 |
| `ByteStream` | `bytes` | 读线程 `rx(data)`，写工具 `tx(data)` | 串口、总线原始字节 |

公共构造参数：`stream_id`（1–64 个 `[A-Za-z0-9_.-]`）、`label`、`description`、`unit`、`value_schema`（JSON Schema，描述 `value` 或整个条目）、`capacity`（条数上限，默认 4096）、`requires`（状态前置）、`channel`、`meta`（如 `{"bits": 16}`）。

### `Stream`（推送）

```python
self.ao = [self.streams.add(Stream(f"ao{c}", label=f"AO{c}", unit="V", channel=c, capacity=1024,
                                   description="Last value accepted by the driver; not a measurement."))
           for c in range(8)]
...
self.ao[channel].publish(volts, source="software_shadow")   # 驱动接受写入之后再发布
```

只在驱动确认接受后发布。附加字段（如 `source`）原样进入条目。

### `SampledStream`（按需采样）

```python
self.streams.add(SampledStream(
    f"ai{c}", label=f"AI{c}", unit="V", channel=c, rate_hz=float(settings.get("aiRateHz", 5)),
    sample=lambda c=c: self._sample_ai(c), requires=("analog_input_configured",),
    value_schema={"type": "number"}))
```

- 只有存在 WebSocket 订阅者或 `stream_start` 保持时才采样；没人看就不访问硬件。
- 每次采样都经过设备操作锁，和工具调用交错执行，不会重叠。
- `sample()` 抛 `DeviceError(category=NOT_CONFIGURED)` → 状态 `not_configured`（控件显示"未配置"）；其他 `DeviceError` → `error`；设备不可用 → `unavailable`。出错后至少间隔 1 s 再试。
- `publish_on_change=True` 时值不变就不写入，适合变化很少的位图。
- `sample()` 绝不能写输出。lambda 里用默认参数绑定循环变量（`lambda c=c: ...`）。

**采样率**：取值范围 0.1–100 Hz，原则是"人眼够用、锁占用可忽略"。

| 量 | 建议 |
|---|---|
| 模拟量读数（单次软件触发） | 2–10 Hz；单次采样耗时 × 通道数 × 频率应远小于 1 s |
| 离散量 / 继电器回读位图 | 5–20 Hz，配合 `publish_on_change` |
| 需要波形的场合 | 不要用采样流；做硬件缓冲采集工具，结果作为一次测量返回 |

采样率放进 `settings` 让人可以调整，并在 `capability_details()` 报告生效值。

### `ByteStream`（字节流）

```python
stream = ByteStream(f"serial{c}", label=f"P{c}", channel=c, max_bytes=self.rx_buffer_bytes,
                    requires=("serial_port_configured",))
stream.set_status("not_configured")     # 端口配置前
```

条目 `{dir: "rx"|"tx", bytes, hex, text}`（`BYTES_SCHEMA`）。`hex` 是精确的原始字节；`text` 是 UTF-8 替换解码，分块边界可能切断多字节字符，仅供显示。按条数 `capacity`（默认 65536）和总字节 `max_bytes`（默认 1 MiB）双重淘汰。

串口类设备的写法（参考 `cp118u_i`）：

1. `open()` 里启动一个守护读线程，`configure_port` 成功后把端口加入轮询集合；`close()` 先置停止事件并 `join`，再关端口。
2. 读线程每 `rxPollMs`（默认 10 ms）一次：`with self.io_lock:` 把驱动 FIFO 里的数据全部读出，调用 `stream.rx(data)`。单个端口出错只把该流置为 `error`，继续轮询其他端口。
3. 写工具在 `io_lock` 内调用驱动写，然后 `stream.tx(data[:rc])`，只记录驱动实际接受的字节。
4. "读取累计接收"类工具从缓冲读：每个端口保存一个"清空游标"，`read_rx` 从游标读到 `head` 并拼接所有 rx 条目，`clear_rx` 把游标移到 `head`。遇到 `dropped` 时在结果里报告 `overflow: true`。
5. 状态：配置前 `not_configured`，轮询正常 `live`，关闭后回到 `not_configured`。

## 状态

`idle`（采样流无人观看）、`running`（采样中）、`live`（推送/字节流正常）、`not_configured`、`unavailable`、`error`、`closed`。用 `stream.set_status(state, {"category": ..., "message": ...})` 设置；值不变时不产生新的 `status` 帧。

## WebSocket 帧

`GET /streams/{streamId}?from=<cursor|-N>`，`Authorization: Bearer <token>`。不带 `from` 只收新数据；`from=-N` 先补最近 N 条；`from=<next>` 断线续传。

| 帧 | 字段 |
|---|---|
| `hello` | `streamId, hardwareId, kind, label, unit, valueSchema, epoch, head, tail, cursor, state, error` |
| `batch` | `items[]`（每 50 ms 合批，最多 500 条）、`next` |
| `gap` | `from, to, reason`：`overflow` 表示读者落后、数据被淘汰；`reset` 表示游标属于另一个 `epoch` |
| `status` | `state, error`，状态变化时发送 |
| `pong` | 回应客户端的 `{"type": "ping"}` |

未知 `streamId`：先发 `status/error`，再以 4404 关闭。令牌错误：握手被拒（401）。服务停机：发 `status/closed` 后以 1001 关闭。

令牌只交给 Electron 主进程（`StreamHub`），不进渲染进程；适配器不需要关心这一点，但不要在流条目里放任何秘密。

## `stream_read`

```
<prefix>_stream_read(hardwareId, streamId, cursor?, max_items=200)
→ {streamId, epoch, items, next, head, tail, reset, dropped?: {from, to}}
```

省略 `cursor` 取最新 `max_items` 条。测试步骤的典型用法：动作前记下 `head`，动作后从该游标读，并确认 `epoch` 未变。采样流需要先 `stream_start(seconds)`，否则无人观看时不产生条目。

## 面板模板（`get_panel`）

`panel()` 返回 `PanelItem` 列表。画布把模板复制成独立控件（不和连线绑定），之后模板变化不影响已放置的控件。SDK 启动时校验：`id` 唯一，引用的工具和流都存在，否则服务起不来。

| 字段 | 说明 |
|---|---|
| `id` | 1–80 个 `[A-Za-z0-9_.:-]`，设备内唯一 |
| `label`、`group`、`description` | 显示用；`group` 用于控件库分组 |
| `widget` | 见下表 |
| `stream` | 实时显示的 `streamId` |
| `field` | 显示条目或结果中的哪个字段，默认 `value` |
| `bit` / `bits` | 整数值取第 `bit` 位（lamp/toggle）/ 一排 `bits` 个灯 |
| `read` | `ToolBinding(tool, args)`：按需刷新（没有流时显示"读取"按钮） |
| `write` | `ToolBinding`：施加控件输入，参数里的 `VALUE`（`"$value"`）被替换成输入值 |
| `actions` | 额外命名动作：终端的 `sendHex`、`configure`、`clearRx`、`status`；读数控件的 `configure` |
| `unit`、`decimals`、`range`（`ValueRange(min, max, step)`）、`options`（`SelectOption(value, label)`） | 显示和输入约束，和工具参数范围保持一致 |
| `confirm` | 写入前让操作者确认；驱动外部信号的控件都应设为 `True` |
| `pins` | 相关的 `pinId`（来自 `get_pinout`），仅用于高亮 |

工具名可以写短名（`set_level`），SDK 会补全前缀。

| `widget` | 绑定 | 例子 |
|---|---|---|
| `readout` | `stream`（数值），可选 `read`、`unit`、`decimals` | AI 电压 |
| `lamp` | `stream` 整数位图 + `bits`，或 + `bit` | DI0..15 |
| `toggle` | `write` 带 `VALUE`（bool），回读 `stream` + `bit` | 继电器、DO |
| `number` | `write` 带 `VALUE`（数值）、`range`、`unit`，回读 `stream` | AO 设定 |
| `select` | `write` 带 `VALUE`、`options` | 量程、模式 |
| `button` | `write`（固定参数） | `safe_state`、复位 |
| `terminal` | `ByteStream` + `write`（文本 `VALUE`）+ `actions.sendHex/configure/clearRx/status` | 串口 P1 |
| `form` | `write` 或 `read` 指向任意工具，按其 `inputSchema` 渲染表单 | `configure_ai` |

没有回读流时，写控件只能显示"最后写入值"，要在描述里说明这不是回读。每个设备都应放一个绑定 `safe_state` 的 `button`。

```python
PanelItem(id=f"do{n}", label=f"DO{n}", group="Digital output", widget="toggle", stream="do", bit=n, confirm=True,
          write=ToolBinding(tool="set_output", args={"channel": n, "level": VALUE}), pins=(pin_id("DO", n),))
```
