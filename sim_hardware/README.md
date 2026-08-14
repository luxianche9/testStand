# 虚拟硬件 MCP Server

本目录是一套独立的 Python 3.10+ 虚拟硬件服务，不依赖 TestForge 源码、Node.js workspace 或 `pnpm`。它不会读取或修改 TestForge 的源码、输出目录或用户数据；硬件包和 MCP Server 均由使用者在 TestForge UI 中手动添加。

| Server | Hardware ID | MCP 地址 | 行为 |
| --- | --- | --- | --- |
| `SIM_AI_MCP` | `SIM_PC.SIM_AI_0` | `http://127.0.0.1:8101/mcp` | 4 路固定模拟输入，默认 `1/2/3/4 V` |
| `SIM_AO_MCP` | `SIM_PC.SIM_AO_0` | `http://127.0.0.1:8102/mcp` | 校验并确认 4 路 ±10 V 输出，不保存状态 |
| `SIM_SERIAL_MCP` | `SIM_PC.SIM_SERIAL_0` | `http://127.0.0.1:8103/mcp` | 写入丢弃，读取固定 UTF-8 字符串 |

三台 Server 只监听 loopback，演示 Token 均为 `testforge-sim-local-only`。该 Token 仅用于本机开发环境。

## 安装与启停

在本目录运行：

```powershell
.\install.ps1
.\start-all.ps1
.\status-all.ps1
.\stop-all.ps1
```

每台 Server 也可独立操作：

```powershell
.\servers\analog_input\start.ps1
.\servers\analog_input\status.ps1
.\servers\analog_input\stop.ps1
```

运行配置位于各 Server 的 `server.json`，首次安装或启动时由 `server.json.example` 创建。PID 和日志分别位于各 Server 的 `run/` 与 `logs/`。

## 生成硬件包

硬件包完全在本目录生成：

```powershell
.\package.ps1
```

可在 UI 中手动导入的文件位于 `hardware_bundles/`：

- `virtual-analog-input.tfhw`
- `virtual-analog-output.tfhw`
- `virtual-serial-card.tfhw`

可复制的完整套件位于 `output/sim-hardware.zip`。打包脚本不访问 TestForge 目录。

## 在 TestForge UI 中手动添加

不要从“添加被动硬件”入口导入这三份硬件包。它们由 MCP Server 管理，应直接在 MCP Server 编辑器中导入：

1. 先用本目录脚本启动三台 Server。
2. 打开设备管理页，新增计算机 `SIM_PC`，显示名称可填写“本机虚拟硬件”，地址填写 `127.0.0.1`。
3. 在 `SIM_PC` 下点击“添加 MCP 服务器”。
4. 在 Server 编辑器中点击“导入硬件包…”，选择与当前 Server 对应的 `.tfhw`。TestForge 会载入 Hardware ID、显示名称、端口、针脚和图片引用，但在保存前不会创建硬件记录。
5. 填写上表中的 Server ID、MCP 地址和 Token `testforge-sim-local-only`，并按 `registration.json` 填写生命周期脚本与日志目录。
6. 保存 Server，确认它显示为在线并发现对应硬件工具；然后重复以上步骤添加另外两台 Server。

编辑已保存的 MCP Server 时，可从同一对话框直接导出其 `.tfhw`。被动硬件的导入/导出入口仍只用于没有 MCP Server 的硬件。

若本机未启用 OpenSSH Server，请用本目录脚本管理进程；MCP 连接和工具发现本身不依赖 SSH。`registration.json` 只是 UI 字段填写参考，不会被任何安装、启动或打包脚本自动导入。

## 固定输入配置

仿真条件只通过本地脚本配置，不作为 MCP 工具暴露。修改后重启相应 Server：

```powershell
.\configure-fixture.ps1 -AnalogInputs 0.5,1.5,2.5,3.5
.\configure-fixture.ps1 -SerialInputs "PORT0_READY","PORT1_READY"
.\reset-fixture.ps1
```

第一版不提供噪声、波形、故障注入、AO 读回、串口回环或卡间联动。

## MCP 工具

- 模拟输入：`read_analog_input`、`read_all_analog_inputs`
- 模拟输出：`write_analog_output`、`write_all_analog_outputs`
- 串口：`write_serial`、`read_serial`

每台 Server 还提供 `get_server_info`、`list_hardware`、`get_hardware_info` 和安全停止工具。所有硬件工具都要求传入与该 Server 一致的 `hardwareId`。

## 独立测试

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
```
