# 应用搭建验收映射

参考 Git revision：`2ecde3ff6c610658a4ea05bb130e26c321e20b6d`。以下路径相对于
`HardwareHarness`。最终执行结果与覆盖率以本目录 `implementation.md` 及原始输出为准。

| 已批准的行为 | 当前回归证据 |
|---|---|
| SDK 只公开主动硬件调用与日志，不在平台外自行连接 | `python/tests/sdk/test_sdk.py::test_public_api_contains_only_hardware_and_logging`、`test_unmanaged_import_cannot_call_hardware` |
| 公共工具、被动对象、隐藏管理工具、错误参数、未声明硬件 | `python/tests/application/test_applications.py::test_hardware_gates_before_remote_send`、`python/tests/automation/test_service.py::test_worker_rejects_undeclared_hardware_and_records_failure`、`python/tests/automation/test_runtime_gates.py::test_worker_surface_rejects_invalid_operations` |
| 一次性本地互斥、不代为申请或释放占用、Agent 与手动调用共享门禁 | `python/tests/application/test_applications.py::test_hardware_claims_are_atomic_and_never_acquire_occupancy`、`test_agent_direct_calls_share_run_execution_claims`、既有 application 手动调用测试 |
| 同硬件冲突、不同硬件并行、占用失效与取消 | `python/tests/automation/test_runtime_gates.py::test_same_hardware_overlap_conflicts_but_disjoint_calls_parallel`、`python/tests/application/test_applications.py::test_agent_call_cancellation_and_closing_release_claims`、既有 occupancy 测试 |
| 同步/异步步骤、嵌套、循环、并发、异常与源码位置 | `python/tests/sdk/test_sdk.py`、`python/tests/sdk/test_transport_worker.py`、`python/tests/automation/test_service.py::test_worker_snapshots_calls_and_records_actual_execution` |
| 输出、测量、附件、代码快照、分页与凭据脱敏 | `python/tests/automation/test_logs.py`、`python/tests/automation/test_runtime_gates.py::test_large_results_and_files_are_exportable_attachments`、`test_worker_credentials_never_reach_records` |
| 硬件调用开始事件先持久化；写盘失败禁止新调用；不自动重放 | `python/tests/automation/test_runtime_gates.py::test_hardware_start_is_durable_before_callback`、`test_disk_failure_prevents_any_hardware_effect`、`test_hardware_errors_preserve_category_without_replay`、`test_transient_log_failure_stops_process_and_reports_failed` |
| 10 秒协作取消，随后终止进程树；崩溃/重启标为中断 | `python/tests/automation/test_service.py::test_async_cancel_runs_finally_and_releases_execution`、`test_restart_marks_unfinished_run_interrupted`、`python/tests/automation/test_runtime_gates.py::test_forced_stop_and_process_crash`、`test_normal_completion_kills_descendant_process` |
| 项目切换、应用停止、退出期间不能启动旧流程；环境准备进程清理 | `python/tests/application/test_applications.py::test_project_switch_rejects_calls_until_new_session_is_ready`、`test_closed_project_service_rejects_queued_switch`、`python/tests/automation/test_runtime_gates.py::test_close_during_environment_preparation_never_launches_old_project`、`python/tests/workspace/test_environment.py` |
| FastAPI 服务与操作 Run 分离；预览认证、Host/Origin、应用范围与停止 | `python/tests/workspace/test_apps.py`、`apps/desktop/e2e/applications.spec.ts`；真实 Electron iframe 校验 desktop bridge 和 require 均为 undefined |
| 编辑、保存、外部文件冲突、路径限制、Python/Ruff 诊断 | `python/tests/workspace/test_workspace.py`、`python/tests/application/test_applications.py::test_production_diagnostics_run_ruff_with_project_python`、renderer `features/applications` 测试与应用 E2E |
| 环境与依赖默认离线；额外依赖显式联网；运行与安装不能重叠 | `python/tests/workspace/test_environment.py`、`python/tests/workspace/test_environment_launch_race.py`、`python/tests/application/test_applications.py::test_dependency_installation_is_offline_unless_explicit`、`python/tests/mcp_gateway/test_application_options.py`、renderer 在线安装回归 |
| 旧项目 v1–v3 原始备份、哈希验证、失败恢复；v4 打开不重写 | `python/tests/projects/test_v4_conversion.py`，细节见 `migration-report.md` |
| Agent 工具替换、开发顺序、历史协议保留范围 | `python/tests/mcp_gateway/test_agent_instructions.py`、`test_boundaries.py`、`test_protocol_golden.py`；新增 initialize.instructions 单独断言，其余初始化响应仍对照旧证据 |
| 桌面界面、嵌入预览、历史 Run、主题和尺寸 | `apps/desktop/e2e/`，输出见 `electron-e2e.txt`；截图见 `visual/after/` 与 `embedded-preview.png` |
| 无系统 Python/uv 的默认应用、中文空格路径、子进程清理 | `python/scripts/smoke_project_runtime.py`，结果见 `python/reports/project-runtime-smoke.json`；最终冻结与安装版执行情况见总报告 |

旧规格覆盖保留不是以测试总数判断。原始 117 个包用例及 3 个旧桌面迁移用例的固定证据
继续保留；83 项保留规格绑定当前测试，37 项节点/旧 Run 规格逐项记录退役理由，
由 `python/scripts/check_specs.py` 校验。删除文件、函数及原始哈希分别记录于
`python-retirements.json`、`retired-ts-node-files.json` 和 `retired-ts-node-cases.json`。

真实物理硬件未在本次测试中发送操作。模拟响应及协议测试验证通用执行链，不能替代所有
实际设备现场联调。独立干净 Windows、物理断网与隔离安装的完成状态在总报告分别列明。
