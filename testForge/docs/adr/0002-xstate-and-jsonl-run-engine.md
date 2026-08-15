# ADR-0002：使用 XState 与 append-only Run 日志

状态：已接受

编排 Run 使用 XState v5 表达生命周期和可持久化 snapshot。内部日志采用每 Run JSONL 增量记录与周期性快照，替代每个事件重写整个 archive。

该设计降低长 Run 的写放大，并使崩溃恢复能够从已确认状态继续。读取器容忍单行损坏并报告 warning；写入失败会重新入队并退避。外部导出的 `TestRunLogArchive formatVersion: 1` 保持不变，因此内部实现可以继续演进而不破坏消费者。
