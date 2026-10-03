# 流

流是设备发布的只读数据：采集读数、输入位图、输出回读、串口收发。HardwareHarness 后端直接读插件的环形缓冲（隔离插件经子进程的 stdio），录制它们，测试步骤按记录时间戳在录制数据上判定，运行监控页把它画成示波器和终端，AI 用内置工具读它。插件本身只发布数据，不判定。控制永远走工具；流和采样函数绝不驱动输出。

## 流声明（`/device.streams`）

每个流在 `/device.streams` 里是它的 `describe()`：`{id, type}` 加上构造时给出的元数据，未设置的字段省略。

| 字段 | 构造参数 | 适用 | 含义 |
|---|---|---|---|
| `unit` | `unit=` | `scalar`、`block` | 物理单位，如 `"V"`、`"degC"` |
| `label` | `label=` | 全部 | 给人看的短名，如 `"AO3"`、`"Relay coil control"` |
| `kind` | `kind=` | 全部 | `measured`（真实采样的物理量）或 `setpoint`（命令值的软件影子，从不是输出的证据） |
| `width` / `bitLabels` | `width=`、`bit_labels=` | `bits` | 位数（1–64）和每一位的名字；只给 `bit_labels` 时 `width` 取其长度，两者不一致时构造报错 |
| `rateHz` | `rate_hz=` | 采样型 | SDK 自动填生效的采样率 |
| `writable` | `writer=` | `bytes`、`frames` | 有写入器（可 `send` / `transact`） |
| `idScheme` | `id_scheme=` | `frames` | `can` / `a429` / `m1553` / `ieee1394` / `raw` |

```python
self.streams.add(ScalarStream(f"ao{ch}", unit="V", label=f"AO{ch}", kind="setpoint"))
self.streams.add(BitsStream("di", sample=self._read_di, publish_on_change=True, kind="measured",
                            bit_labels=[f"IDI{n}" for n in range(16)], rate_hz=20.0))
```

元数据只是声明：程序里不把流和工具、针脚关联。AI 靠 id、`label` 和工具描述理解它，所以 id 要和工具参数里的通道号对得上（`ai3` 对应 `channel=3`，`serial2` 对应 `channel=2`）。id 为 1–64 个 `[A-Za-z0-9_.-]`。只写手册能证实的单位；`kind` 不确定就不写。

## 六种类型

| 类 | `type` | 记录 | 典型资源 |
|---|---|---|---|
| `ScalarStream` | `scalar` | `{v}` 数值 | AI 电压、温度、DMM 读数、AO 回读 |
| `BitsStream` | `bits` | `{mask}` 非负整数，bit i = 第 i 路 | DI、DO / 继电器回读 |
| `ByteStream` | `bytes` | `{dir: tx\|rx\|mark, data: 小写 hex, note?}` | 串口、TCP 透传 |
| `FrameStream` | `frames` | `{dir, id, data, note?}` | CAN、LIN、SPI 事务 |
| `BlockStream` | `block` | `{t0, dt, samples[]}`，第 i 个样本时刻 `t0 + i*dt` | 示波器波形、硬件定时采集 |
| `BlobStream` | `blob` | `{ref}`，内容用 `<prefix>_blob_read` 取 | 截图、照片、日志文件 |

SDK 给每条记录加 `seq`（缓冲序号，从 0 递增）、`t`（SDK 时钟 `now_ms()`，Unix 毫秒，单调锚定，同一流内严格递增；与后端是同一个时钟）和 `op`（产生它的工具调用的操作号，没有则省略）。适配器从不自己写时间戳和操作号。

多通道同步扫描不是新类型：一次扫描发布到多个 `scalar` 流，共享同一个 `t`（见下文 `scan`）。

## 采样型与事件型

**采样型**：给一个同步 `sample()`，SDK 在自己的线程上按 `rate_hz` 调用。

```python
self.di = self.streams.add(BitsStream("di", sample=lambda: self._read_mask("DI"), publish_on_change=True,
                                      rate_hz=float(settings.get("bitRateHz", 20))))
```

- 只在有人看时采样：后端 `watch` 这条流（测试运行的录制、运行台或设备页的实时显示）。没人看就不访问硬件。
- 每次采样持有 `self.io_lock`，但不经过工具调用的操作锁：采样和工具调用交错，不会同时访问驱动。
- `sample()` 返回 `None` 表示这次没有值（状态 `not_configured`）；抛 `DeviceError(category=NOT_CONFIGURED)` 同样是 `not_configured`，不计错误；其他异常计入 `errors`，状态 `error`，流不中断。
- 每次尝试（包括失败）都推进水位，判定器据此知道"这段时间确实没有数据"。
- `publish_on_change=True`（仅 `BitsStream`）：掩码与上一条相同就不写入，适合变化很少的输入。
- `rate_hz` 取值 0.1–200 Hz，放进 `settings` 让人可调，并在 `capability_details()` 报告生效值。
- lambda 里用默认参数绑定循环变量：`lambda c=c: self._read(c)`。

**扫描组**：一次读取多个通道，用 `self.streams.scan(streams, fn, rate_hz=)`。`fn()` 返回与 `streams` 等长的列表，`None` 跳过该通道。流必须先 `add` 再 `scan`。

```python
self.ai = [self.streams.add(ScalarStream(f"ai{c}")) for c in range(16)]
self.streams.scan(self.ai, self._scan_ai, rate_hz=float(settings.get("aiRateHz", 20)))

def _scan_ai(self) -> list[float | None]:
    # 未配置的通道返回 None；一次驱动调用读完所有配置过的通道。
    ...
```

**事件型**：没有 `sample`，由适配器在读写路径上发布：`ScalarStream.publish(v)`、`BitsStream.publish(mask)`、`ByteStream.rx/tx/mark`、`FrameStream.rx/tx/mark`、`BlockStream.publish(samples, dt, t0=)`、`BlobStream.publish(data, mime)`。只在工具调用里同步发布的事件型流（写即发布的回读、设定值），水位随时钟推进；有后台读线程的 `bytes` / `frames` 流由读线程调 `idle()` 推进水位（见下文字节流）。没有新数据时，读取方至少每 200 ms 收到一次带水位的 `status` 事件。

## 采样多少、怎么读

| 量 | 建议 |
|---|---|
| 模拟量（软件触发单次读） | 10–20 Hz；能一次读多通道就用扫描组 |
| 离散量 / 继电器回读 | 10–20 Hz，配合 `publish_on_change`；用一次读整个端口的原语，不要逐位读 |
| 波形 | 不要用高采样率的 `ScalarStream`；有硬件定时采集就用 `BlockStream(read_block=...)`，`read_block()` 返回 `(samples, dt_ms)` 或 `(samples, dt_ms, t0_ms)`，没有新块返回 `None` |

驱动一次调用的耗时 × 频率应远小于 1 s，否则采样会挤占工具调用。

## 写即发布

输出类工具写完立即向回读流发布一条，不等下一次采样；写失败也回读一次，让流反映硬件实际状态：

```python
def _write(self, command):
    try:
        return self._request(command)
    finally:
        try:
            self.relay.publish(self._read_mask("RELAY"))   # 控制器回读
        except DeviceError:
            pass                                          # 写本身的错误才是要报告的
```

没有回读能力的输出（如 AO 只有软件影子）在驱动接受后发布设定值：`self.ao[channel].publish(volts)`，这种流声明 `kind="setpoint"`。回读流是可选的，只为显示方便：判定输出以工具调用记录为准（调用参数、结果、设备端起止时间），物理输出要独立测量。

没有硬件定时的静态输出要出低频波形时，用 SDK 的 `SoftwareWaveform`（见 `sdk-api.md`）：它在自己的线程上持 `io_lock` 写驱动，并把每个写出的点发布到该通道的 `setpoint` 流。

发布发生在工具调用里时，记录自动带上该调用的 `op`，结果信封的 `meta.streamRefs` 列出本次调用写入的 `{streamId, fromSeq, toSeq}`。

## 字节流（串口配方）

```python
self.streams.add(ByteStream(f"serial{ch}", writer=lambda data, ch=ch: self._send(ch, data),
                            max_bytes=self.rx_buffer_bytes))
```

- **读线程**：`stream.rx(data)`，只记录驱动实际读到的字节；空字节被忽略。读线程访问驱动时持 `self.io_lock`。
- **`idle()`**：读线程每次读返回（读到空、FIFO 已清空）都调 `stream.idle()`，确认"到此刻为止没有更多字节"，推进水位；未配置的端口在每轮轮询里也调 `idle()`。轮询间隔不超过 100 ms，保证水位落后时钟不超过 `IDLE_INTERVAL_MS`（200 ms）。第一次调用后水位只由 `idle()` 和新记录推进，读线程停了水位就停，判定器因此不会把"读线程卡住"当成"没有数据"。`--check` 对从不调 `idle()` 的字节 / 帧流给出警告，对水位落后超过约 350 ms 的判为失败。

```python
def _drain(self, channel):          # 调用方持 io_lock
    port, stream = self.port_map[channel], self._stream(channel)
    while True:
        count, data = self.pcomm.sio_read(port, READ_CHUNK)
        if count <= 0 or not data:
            stream.idle()           # 读返回：没有更多字节
            return
        stream.rx(data)
```
- **写入器** `writer(data) -> int | None`：返回驱动接受的字节数（`None` 表示全部）。写入器自己持 `io_lock` 并检查配置门槛（未配置抛 `NOT_CONFIGURED`），因为内置 `transact` 只经过操作锁就调用它。
- **发送**一律走 `stream.send(data)`：它调用写入器，并把实际接受的字节记为 `tx`。不要在写工具里另外调 `stream.tx`。
- **标记** `stream.mark(note)`：配置、清空、复位等事件写一条 `dir="mark"` 记录，返回含 `seq` 的记录。`read_rx` 类工具用 `mark(...)["seq"] + 1` 作为清空后的读游标，不必丢弃缓冲。
- `max_bytes` 限制缓冲总字节，超出时丢弃最老记录，读取方因此收到 `gap`。
- 端口未配置时把流状态设成 `not_configured`（`stream.set_state("not_configured")`），配置后设 `live`；读线程出错设 `error` 并带 `{category, message}`；`close()` 时设 `closed`。
- 有写入器的字节流自动获得 `<prefix>_transact`（发送并在期限内等匹配的应答）。

`FrameStream` 同理：`writer(frame_id, data)`，`send(frame_id, data)` 记 `tx`，读线程同样调 `idle()`；`id_scheme=` 声明帧 id 的含义。

## 状态

`status()` 返回 `{state, sampling, errors, lastError?, watermark}`。

| state | 谁设 | 含义 |
|---|---|---|
| `idle` | SDK | 采样型流，没人看 |
| `sampling` | SDK | 采样型流，正在采样 |
| `live` | SDK / 适配器 | 事件型流可用（启动时 SDK 自动设） |
| `not_configured` | SDK / 适配器 | 前置配置缺失 |
| `error` | SDK / 适配器 | 最近一次采样或读线程出错 |
| `unavailable` | SDK | 设备未打开 |
| `closed` | 适配器 / SDK | 设备已停止 |

适配器可以用 `stream.set_state(state, error=None)` 设任意小写状态名，但优先用上表。

## 读取与水位

流不经网络。后端和测试工具都通过 `DeviceHost` 读同一个环形缓冲：

| 方法 | 说明 |
|---|---|
| `watch(streamId)` / `unwatch(streamId)` | 观看计数；采样型流只在计数大于 0 时采样 |
| `read_stream(streamId, cursor, limit, epoch=None)` | 从 `cursor` 读（`None` 只要新记录，负数为最后若干条），返回 `{streamType, epoch, records, next, watermark, gap?, status}` |
| `seek(streamId, since)` | 第一条 `t ≥ since` 的记录的游标；电平型流（`scalar`、`bits`）返回该时刻仍然有效的那一条，所以窗口起点的值总是已知 |

`epoch` 与游标不一致（设备重开、缓冲重建）时，从最旧记录重来并报 `gap{reason: reset}`；要读的记录已被覆盖时报 `gap{reason: overflow}`。后端（以及测试里的 `hh.subscribe`）把读取结果整理成事件：

| 事件 | 字段 |
|---|---|
| `hello` | `streamId, streamType, epoch, fromSeq` |
| `batch` | `records[]`（带 `seq`、`t`、`op?`），`watermark` |
| `gap` | `fromSeq, toSeq, reason`（`overflow` 缓冲溢出 / `reset` 换了 epoch，从最旧记录重来） |
| `status` | `state, sampling, errors, lastError?, watermark`；变化时或每 200 ms 一次；设备关闭时最后为 `state: closed` |

**水位** `watermark`：SDK 保证该流 `t ≤ watermark` 的记录都已在缓冲里（或已以 `gap` 报告）。录制方和测试步骤用它区分"没有发生"和"还没到"。采样型流每次尝试推进水位；带读线程的事件型流由 `idle()` 推进；只在工具调用里同步发布的流随时钟推进。每次设备启动缓冲有新的 `epoch`，游标只在同一 `epoch` 内有效。

## 内置工具

| 工具 | 何时有 | 说明 |
|---|---|---|
| `<prefix>_stream_read(streamId, fromSeq?, limit=200)` | 总有 | 不消费地读；省略 `fromSeq` 取最新 `limit` 条；返回 `records, next, head, tail, watermark, epoch, status, reset, dropped?`；字节记录额外附 `text` |
| `<prefix>_transact(streamId, data, encoding, expect?, timeoutMs)` | 有写入器的字节流 | 发送并等应答（`expect` 是正则，在累计的 rx 文本上搜索，只决定何时停止等待，不是判定）；`kind=actuate`，从不自动重试 |
| `<prefix>_blob_read(streamId, ref)` | 有 `BlobStream` | `{ref, mime, size, base64}` |

这些工具给 AI 和手动调试用。流的声明从 `/device.streams` 读，没有 `list_streams`。窗口统计、等待条件和通过 / 失败判定由测试步骤在录制数据上计算，AI 经网关工具使用，SDK 不提供。

## 测试写法

```python
with hh.subscribe("serial1", cursor=0) as events:
    assert receive_until(events, lambda e: e["type"] == "hello")["streamType"] == "bytes"
    hh.call("write_text", operation_id="op-w", channel=1, text="hi")
    batch = receive_until(events, lambda e: e["type"] == "batch" and e["records"])
```

- 写工具：断言 `result["meta"]["streamRefs"]` 指向的记录内容和 `op`。
- 采样流：改模拟器状态后用 `hh.subscribe` 或 `stream_read` 读出新值。
- 字节流：回环模式下断言 `tx` / `rx` / `mark` 顺序，`transact` 在未配置时报 `not_configured`；断言 `stream.idle_driven` 且水位落后时钟不超过 200 ms。
- 流声明：断言 `hh.device()["streams"]` 等于期望的 `describe()` 列表（含元数据）。
