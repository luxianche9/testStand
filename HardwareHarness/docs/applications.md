# 应用搭建

打开工程后进入“应用搭建”。初始化项目环境，再创建应用，或在文件树中创建
`workflows/main.py`。每个项目使用 `.hardwareharness/.venv`，依赖由同目录的
`pyproject.toml` 和 `uv.lock` 管理。默认模板是 FastAPI + HTML/JavaScript，不需要 Node 构建。

## 开发与运行

流程入口是 `main(inputs)`，支持普通函数和异步函数。入口配置填写相对于
`.hardwareharness` 的 Python 文件路径，例如 `workflows/main.py`，不带 `:main`。
输入和返回值使用 JSON；图片、采样文件和其他结果使用附件。

```python
from hardwareharness import log, measurement, step


@step("计算测试结果")
def main(inputs: dict[str, object]) -> dict[str, object]:
    log("流程已启动", fields=inputs)
    measurement("示例值", 3.3, unit="V")
    return {"completed": True}
```

硬件调用使用 `call(hardware_id, tool_name, arguments, timeout_ms=...)` 或
`await acall(...)`。工具名和参数从设备工具 schema 获取；SDK 返回完整 MCP 结果，
包括 `content` 和存在时的 `structuredContent`。常见数据在 `structuredContent.data`，
具体结构以设备 schema 为准。原有手动调用和 Agent 直接工具调用的默认返回值不变。
详见 [SDK 接口说明](../python/src/hardwareharness/README.md)。

Agent 的工作顺序是：读取设备能力和资料，处理接线和占用，编写代码，使用模拟硬件测试，
启动真实流程，检查日志。SDK 不提供占用、接线、人工确认或业务上下文接口。
占用不足立即报错；平台不代为申请、不等待人工操作后重放硬件命令。

应用清单登记服务入口和操作，每项操作声明流程路径、输入 schema、硬件 ID。
常驻 Web 服务只处理页面和请求，每次业务操作由平台创建独立 Python 进程和 Run。
页面使用平台模板中的操作接口，不直接连接硬件，也不持有工作进程或管理凭据。

## 文件、日志与取消

- 编辑器支持文件和目录操作、多标签、搜索、Python/Ruff 诊断。运行前先保存修改。
- 外部文件变更自动刷新未修改标签；存在未保存修改时显示冲突，不覆盖编辑内容。
- 每次运行保存代码快照和依赖记录，运行中的流程不受后续文件编辑影响。
- 使用 `step` 记录业务步骤，使用 `log`、`measurement`、`attachment` 记录结果。
  硬件调用、异常、输出和耗时自动记录，可查看步骤关系、事件、源码与附件。
- 相同硬件不能被其他 Run、手动调用或 Agent 直接调用同时操作。
  同一 Run 内对同一硬件的重叠调用也返回冲突；业务代码需要显式顺序调用。
- 取消先请求协作退出，最多等待 10 秒后终止进程树。强制退出不能保证执行 `finally`。
  清理中的硬件调用仍需有效占用；取消或超时不代表远端硬件动作已经撤销。
- 重启后未完成记录标记为中断，不恢复 Python 调用栈，不重放操作。

工作区隐藏平台生成的虚拟环境、日志、附件、运行快照和备份。停止应用会取消所属流程并等待退出；
项目切换和退出会清理应用、流程与环境准备进程。第一版没有交互式终端或断点调试器。

## 旧工程与交付环境

v1–v3 工程首次打开时备份原始清单和旧运行文件，核对字节哈希后提交 v4 清单。
工程身份、接线、设备和用户代码保留；节点任务不转换成 Python，旧日志不进入新界面。
备份位于 `.hardwareharness/backups/legacy-*`。平台不会自动删除这些备份。

Windows 安装包包含冻结后端，以及独立 CPython 3.11、uv、SDK 和默认应用的离线依赖。
新环境创建在可写的项目目录，安装目录不写入运行数据。额外第三方依赖需要可用的软件源或
自行提供离线包。在编辑器保存 `pyproject.toml` 后，停止应用和流程，再点击“联网安装依赖”。
普通初始化仍使用安装包中的离线依赖；安装成功或失败会在界面显示。Agent 的
`initialize_workspace` 只有明确传入 `online: true` 才启用安装版的软件源访问。
项目代码是本地 Python 程序；Web 预览的隔离不构成 Python 的系统沙箱。
