# contracts / storage / projects / wiring 移植对照

本组实现及测试已稳定，未修改 TS 包、renderer 或 opencode 文件。最终独立检查：ruff、mypy strict（40 个源文件）通过；pytest **438 passed in 4.63s**。完整门禁和桌面打包由主任务统一执行。

## 原始规格保留

| TS 测试文件 | 原用例数 | Python 对应文件 |
| --- | ---: | --- |
| packages/contracts/src/contracts.test.ts | 8 | tests/contracts/test_contracts.py |
| packages/storage/src/storage.test.ts | 3 | tests/storage/test_storage.py |
| packages/storage/src/run-log-store.test.ts | 5 | tests/storage/test_run_log_store.py |
| packages/projects/src/project-service.test.ts | 6 | tests/projects/test_projects.py |
| packages/wiring/src/project-wiring-agent.test.ts | 2 | tests/wiring/test_wiring.py |

以上 24 个原用例均先建立 `ts_case` 对应断言，再实现业务。另在本组保留 application/project-services 的 5 个跨包用例，以及 main/migrations 的 secret 写入失败恢复用例。详细原始断言清单由 `ts-assertion-inventory.json` 与 `specification-map.json` 统一记录。

原 TestStep 静态规格使用公共 `TestStep` TypedDict union：8 个 step 变体、递归 WorkflowValueTemplate / WorkflowExpression、重试类别、必要及可选字段均有明确类型。`parse_test_step` 返回该 union，原断言为 `assert_type(step, TestStep)`。`tests/contracts/test_workflow_types.py` 用全部变体的字段类型、递归字段、穷尽分支和预期失败声明检查约束；mypy strict 的 `warn_unused_ignores` 防止负例被弱化后静默通过。

## 工程升级和磁盘格式

当前原源码的工程升级链位于 contracts/projects.ts，由 ProjectService.openFolder 触发落盘。Python 保留相同分工与行为：

- v1 → v2：保留现有 task；缺少 task 时生成 `${projectId}-task`，名称沿用工程名，五个任务集合（inputs、variables、setup、steps、cleanup）为空。
- v2 → v3：只升级工程 formatVersion；任务格式仍为 2，已有任务和元数据保持原值。
- inspect 不写盘；open 仅在存储版本不同于解析版本时保存升级结果。未来版本与损坏工程清单拒绝打开，原字节保持不变。
- 修改 task/wiring 只更新内存和 dirty 状态；save 才写文件，leave/close 不隐式保存。
- JSON 使用 UTF-8 无 BOM、两空格缩进和一个末尾 LF；JSONL 每条为紧凑 JSON 加 LF。保留 JavaScript 对象键顺序、数字文本、undefined 省略规则及 UTF-16 代理项编码规则。
- 原子写入保留同目录随机临时文件、独占创建、flush/fsync、rename、目录同步与异常清理；settings 和 secrets 保留串行队列及失败不污染已提交状态的语义。
- run 日志保留追加记录、按事件编号去重排序、节点首次出现顺序、快照压缩、旧 archive 迁移与警告格式。`formatVersion: true` 与数字 1 严格区分。

原线性写入性能断言完整保留：1000 事件分批追加、十秒上限、与逐次重写完整 archive 的累计字节量比较。测试只把重复 JSON 序列化的参考计算换为相同累计长度公式，避免覆盖仪器导致参考计算过慢。

## 直接差分证据

所有黄金结果最终均由 **Electron 36.9.5 / Node 22.19.0 / V8 13.6 / ICU 74.2** 运行未修改的 TS 源码或 Node 内建 API 产生，而非由 Python 实现反推。

- `scripts/contracts-parity-oracle.cjs`：229 个 Zod 样例。比较成功返回数据及完整 pretty JSON 字符串，失败比较完整 issues 及 message 字段顺序。覆盖 default/strip/strict、联合类型脏分支、refinement、版本、日期、错误传输和不合法输入。
- 其中 70 个 WHATWG URL 边界样例覆盖非法端口、无双斜杠 URL、特殊/非特殊 scheme、IPv4/IPv6、IDN、转义主机、C0/Unicode 空白和代理项。`ada-url==1.15.3` 的源码 `ADA_VERSION` 为 **2.9.2**，与 Electron 相同；使用现成 cp311-cp311-win_amd64 wheel。
- `scripts/runtime-parity-oracle.cjs`：4 组 storage、2 组 wiring 场景。逐步比较返回值/异常、通知次数及顺序、画布状态、任务状态；storage 还比较目录相对路径、每个文件的完整字节文本和每次写入字节统计。
- `scripts/fs-parity-oracle.cjs`：15 个 Windows 文件系统黄金场景，覆盖 ENOENT、EISDIR、ENOTDIR、EEXIST、EPERM、rename 双路径、只读文件删除和 rm 行为。另有空字符路径、只读 run 递归删除、损坏工程路径和 recent 项的公开错误文本断言。
- JSON 损坏错误由兼容层按 V8 重建：127 个原始错误黄金及 2 个合法语义测试；协作组另以 1164 条随机损坏输入（750 条非法）对照 Electron，零差异。已覆盖 UTF-16 位置、CR/LF/CRLF、非法 token、截断、转义、数字与负零。
- 另对 10000 个随机 IEEE754 值比较 Node / Python JSON 数字文本，未发现差异。

黄金文件：`tests/contracts/contracts-golden.json`、`tests/storage/storage-golden.json`、`tests/wiring/wiring-golden.json`、`tests/compat/fs-golden.json`。原始脚本仅为测试工具，不参与运行时依赖。

## 本组覆盖率

| 包 | TS 原行 / 分支 | Python 行 / 分支 |
| --- | ---: | ---: |
| contracts | 89.90% / 80.95% | 94.92% / 94.52% |
| storage | 93.13% / 82.96% | 99.29% / 93.62% |
| projects | 92.50% / 71.21% | 96.36% / 80.77% |
| wiring | 77.11% / 65.57% | 99.38% / 92.86% |

这是仅运行本组测试的覆盖率，四包均超过原始基线。原始计数在 `storage-group-coverage-summary.json`，逐行证据在 `python-storage-group-coverage.json`；主任务会另生成全量报告。

## 已批准原缺陷修正与打包要求

本组唯一故意偏离是拒绝 run id `""`、`"."`、`".."`，避免 encodeURIComponent 保留点路径后删除父目录。回归在 `tests/storage/test_run_log_store.py::test_dot_run_never_operates_on_parent`，验证 remove、clear、旧 archive 迁移均不会删除已保存的安全 run；总缺陷清单另见 `bug-deviations.md`。

新增 URL 依赖锁定于 pyproject.toml / uv.lock。冻结程序应包含 `ada_url._ada_wrapper.pyd` 和 `_cffi_backend`；Ada 已编译进扩展，不依赖外置 ada.h/ada.cpp 或额外数据目录。无已知尚未处理的本组移植差异。
