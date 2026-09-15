# 动作编排

打开工程后进入“动作编排”。页面只保留左侧脚本列表、右侧编辑器和运行按钮、底部可折叠输出终端。脚本列表只显示
`.hardwareharness/scripts/**/*.py`。`scripts` 下可以建立子目录，但文件必须是 Python
脚本；HTML、JavaScript、CSS、JSON 和其他文件不会被接受或显示。

每个项目仍使用 `.hardwareharness/.venv`。平台管理同目录的 `pyproject.toml` 和
`uv.lock`，这两个文件不显示在脚本列表中。首次运行时自动准备离线环境；页面不再显示环境准备或联网安装按钮，也不会自动联网安装依赖。

## 编写与运行

可运行脚本定义 `main(inputs)`，支持普通函数和异步函数。选择脚本后点击“运行”，自动保存当前工作区的脚本修改并直接执行，默认输入为 `{}`。运行入口为相对于
`.hardwareharness` 的路径，例如 `scripts/main.py`。输入和返回值使用 JSON；图片、
采样文件和其他文件结果使用附件登记。

```python
from hardwareharness import log, measurement, step


@step("计算测试结果")
def main(inputs: dict[str, object]) -> dict[str, object]:
    log("程序已启动", fields=inputs)
    measurement("示例值", 3.3, unit="V")
    return {"completed": True}
```

硬件调用使用 `call(hardware_id, tool_name, arguments, timeout_ms=..., result_mode="data")` 或
`await acall(...)`。工具名、参数与业务数据结构来自当前工具契约。默认
`result_mode="envelope"` 保持旧程序兼容，返回完整 MCP 结果，包括 `content` 和存在时的
`structuredContent`；新程序可显式选择 `data`，按契约读取业务数据。详见
[SDK 接口说明](../python/src/hardwareharness/README.md)。

Agent 和现有管理界面负责读取设备能力、处理接线和接线确认。脚本 SDK
不提供这些管理接口。设备离线或执行冲突会立即报错，平台不会自动
重放硬件命令。

## 文件、记录与取消

- 编辑器保留 Python 语法高亮与 Ctrl+S 保存；脚本列表宽度、选中脚本、草稿及终端折叠状态会恢复。
- 左侧“新建脚本”输入名称后创建并自动打开，省略扩展名时自动补全 `.py`，初始内容包含可直接运行的 `main(inputs)`。同名文件不会被覆盖。
- 目录管理、重命名和删除交由 Agent 或外部编辑器完成。页面不显示搜索栏、多标签栏、诊断和运行配置弹窗。
- 外部修改会自动刷新未改动的脚本；存在未保存修改时保留草稿，保存冲突在终端显示，阻止执行旧代码。
- 运行时终端自动展开，显示标准输出、错误输出、日志与完成状态。同一个运行按钮在执行期间变为“停止”；完整结构化记录在“运行日志”查看。
- 每次运行从已保存代码建立快照并启动独立 Python 子进程，之后的编辑不影响该次运行。
- `step`、`log`、`measurement` 和 `attachment` 记录业务步骤与结果；硬件调用、异常、输出和耗时自动记录。
- 相同硬件不能被重叠调用；不同硬件可以并行执行。
- 取消先请求协作退出，最多等待 10 秒后终止进程树。强制终止不能保证执行 `finally`。
- 重启后未完成的 Run 标记为中断，不恢复 Python 调用栈，也不重放硬件操作。

该页面不提供 FastAPI 应用、HTML/JavaScript 编辑、iframe Web 预览、交互式终端或断点调试器。

## 旧工程与发布环境

v1–v3 工程首次打开时备份原始清单和旧运行文件，核对字节哈希后提交 v4 清单。
工程身份、接线、设备和已有用户代码保留；节点任务不转换成 Python，旧日志不进入新界面。

Windows 安装包包含冻结后端、CPython 3.11、uv、SDK 和默认离线依赖。项目环境创建在
可写的工程目录，安装目录保持只读。额外第三方依赖需要可用的软件源或用户提供的离线包。

## Agent 的公开开发与诊断入口

内嵌 OpenCode 的默认 `build` 与 `plan` Agent 使用随包发布的 HH 指令。MCP 初始化也提供
相同指令，平台行为通过当前公开工具和资料解释。用户的项目代码、固件源码和厂商手册仍可
用于任务；使用发行版不需要 HH 开发仓库。

| 任务 | 公开入口与行为 |
| --- | --- |
| 确认版本与环境 | `get_agent_context` 返回工程模式、版本、环境状态和资料索引；`get_execution_availability` 查询设备当前冲突。 |
| 查工具与 SDK 用法 | `get_tool_contract` 返回当前名称、参数、结果契约和 SDK 调用示例；`read_reference` 分页读取已登记的随包资料。 |
| 创建与更新脚本 | `create_workspace_file` 独占创建文件；已有文件先 `read_workspace_file`，再以返回的 hash 调用 `write_workspace_file`，防止覆盖其他修改。 |
| 验证与执行 | 保存后 `validate_python_file` 做语法与 Ruff 检查，再用 `start_python_run` 执行；静态检查不代表硬件验收通过。 |
| 检查完整结果 | `get_python_run_summary` 读取摘要，`get_python_run_events` 按游标分页，`read_python_run_source` 与 `read_python_run_artifact` 读取该次运行的源码快照和证据。 |
| 等待既有操作 | `wait_for_status` 对已存在的运行、接线或服务状态有界等待；硬件作业继续使用其公开作业查询工具。 |
| 提交固件 | `import_firmware_artifact` 将用户文件导入目标服务受管目录并校验哈希，使用返回的固件引用或路径。 |

端口引用直接使用设备目录返回的 `endpointRef`，不从名称拼接。创建接线待办、人工确认和
实测连通分别记录。最后写入值、缓存与驱动确认不能代替物理测量；程序状态 `succeeded`
只表示正常返回，业务结果 `passed=false` 表示验收未通过。

超时或取消可能留下未知的远端结果。使用原 `runId` 或 `jobId` 查询，不因超时自动重新
发送、写入、复位或烧录。带主动输出的程序需要分别尝试必要清理并记录失败；`safe_state`
使用设备配置，不能假定所有设备归零。
