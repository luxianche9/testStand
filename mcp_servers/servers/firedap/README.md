# FireDAP 本地 STM32 烧录 MCP

基于仓库现有 `cp118u_i` 等 MCP Server 模板的管理契约实现：一个进程、一个 `serverId`、一个受管硬件、占用租约、结构化结果及安全停机。烧录驱动使用 pyOCD 的 CMSIS-DAP/SWD 接口。

| 项目 | 值 |
|---|---|
| 服务 | `FIREDAP_MCP` |
| 受管硬件 | `LOCAL_MCP.FIREDAP_0`，野火 FireDAP |
| 被动被测板 | `DUT_1`，野火 STM32F407 霸天虎 V2 |
| 本地电脑 | `LOCAL_PC`，`execution: local`，无需本机 SSH |
| 地址 | `http://127.0.0.1:8015/mcp` |
| MCU | STM32F407ZGT6，内置 Flash 1 MiB |
| 协议 | SWD，默认 1 MHz |
| 芯片包 | 本地 `Keil.STM32F4xx_DFP.3.1.1.pack` |

## 安装、启停和入库

在本目录执行：

```powershell
.\install.ps1 -DocsRoot 'E:\Project\learnSTM32\doc' -FirmwareRoot 'E:\Project\learnSTM32'
.\start.ps1
.\status.ps1
```

安装脚本创建 `.venv`、安装依赖，并在只有一个 FireDAP 时选择其完整序列号。多下载器时用 `-ProbeSerial` 指定。已有 `server.json` 会保留，不自动覆盖配置。`server.json`、固件、日志、运行记录均不入 Git。

首次注册前，在 `testForge` 目录运行 `pnpm build:packages`，关闭 TestForge，然后用仓库 Electron 运行 `register-testforge.cjs`：

```powershell
# 工作目录为 testForgeDev；若环境中存在 ELECTRON_RUN_AS_NODE，请先移除该变量。
& '.\testForge\apps\desktop\node_modules\electron\dist\electron.exe' '.\mcp_servers\servers\firedap\register-testforge.cjs'
```

注册使用 TestForge 自身的 DeviceStore、校验规则、硬件包导入和 Electron safeStorage。原硬件及凭据先备份到用户目录 `backups/firedap-时间戳`。`DUT_1` 保留原标识、CAN/RS485 端口标识；其他已有硬件不变。然后正常打开 TestForge。

可用 `verify-desktop.cjs` 启动已构建的桌面端进行真实 API 验证；它不开放调试端口，验证后保留正常桌面窗口。报告写入 `run/desktop-verification.json`。

TestForge 的本机服务按钮调用 `start.ps1` / `stop.ps1`。停机先检查没有正在运行的硬件任务，再退出服务；使用进程路径和启动时间验证进程归属。

## 接线

开发板单独供电，FireDAP USB 接本机。5 芯同面排线连接 FireDAP SWD 和开发板 J1：

| 针号 | FireDAP | 霸天虎 V2 J1 |
|---|---|---|
| 1 | VREF，目标参考电压输入 | 3V3 |
| 2 | SWDIO | PA13 |
| 3 | GND | GND |
| 4 | SWCLK | PA14 |
| 5 | NRST | NRST |

VREF 是参考电压，不能默认作为开发板电源。正常运行选择 BOOT0=0。接口编号须对照插座标识和手册，不按照片观看方向猜测。

## 烧录流程

1. 在 TestForge 中占用 FireDAP 硬件。
2. 调用 `firedap_inspect_firmware`，传入本机固件绝对路径。BIN 还需明确 `base_address`，通常为 `134217728`（`0x08000000`）。HEX/ELF/AXF 使用文件自带的加载地址。
3. 将返回的 SHA-256 原样传给 `firedap_flash` 的 `expected_sha256`，并提供相同文件路径和地址。
4. 返回的 `jobId` 仅表示已开始。用 `firedap_get_job(job_id)` 轮询，直到 `state` 为 `succeeded` 或 `failed`。
5. 只有 `succeeded` 且 `result.verified=true` 才表示烧录及逐字节回读成功。默认成功后复位运行；`reset_after=false` 时不复位。完成后释放占用。

`firedap_verify` 只比对已有 Flash；`firedap_target_info` 只连接并读取芯片信息；`firedap_reset` 执行复位。这三者都使用相同的异步任务方式。硬件参数 `hardwareId` 和占用令牌由 TestForge 注入。

| 工具类别 | 工具 |
|---|---|
| 模板管理 | `get_server_info`、`list_hardware`、`get_hardware_info`、`get_pinout` |
| 本地检查 | `firedap_list_probes`、`firedap_inspect_firmware`、`firedap_get_board_reference`、`firedap_get_job` |
| 硬件操作 | `firedap_flash`、`firedap_verify`、`firedap_target_info`、`firedap_reset` |
| TestForge 内部 | `testforge_hardware_occupancy`、`testforge_prepare_shutdown` |

## 行为边界

- 仅允许写入 `0x08000000..0x080FFFFF` 的内置 Flash，支持 BIN、Intel HEX、ARM ELF/AXF。其他格式、空文件、重叠段、越界及 SHA 不符均拒绝。
- 通过完整序列号精确选择 CMSIS-DAP，操作前检查 DBGMCU 设备组为 `0x413` 且 Flash 为 1024 KiB。该标识无法单独区分 F405/F407 或封装，板型仍由用户及资料确认。
- 禁止自动解锁读保护，不提供全片擦除或选项字节写入，不支持外置 W25Q128/SRAM 烧录。
- 使用扇区擦除，保留同一扇区内未包含在固件中的字节；烧录成功后独立逐字节回读校验。
- 先读取并校验整个固件快照，再把同一份数据交给工作进程，避免文件在审核后被替换。只接受 `firmwareRoots` 内的文件。
- 同时只运行一个硬件任务。租约有效期 15 秒，TestForge 每 5 秒续租。烧录期间即使客户端断开，任务继续完成或达到超时；此时其他客户端不能接管，服务不会中途正常停机。
- 独立工作进程默认超时 120 秒。超时/USB 断开可能留下部分写入或停止的 MCU，必须检查结果后重试。进程在空目录运行，避免 pyOCD 自动加载工程中的用户脚本。
- 任务结果保存在 `run/jobs`；工具仅查询当前服务会话内最近 100 个任务。重启后历史记录可从文件查阅。

## 验证

```powershell
.\.venv\Scripts\python.exe -m pip install -e '.\app[test]'
.\.venv\Scripts\python.exe -m pytest app/tests -q
.\.venv\Scripts\python.exe smoke_test.py
.\.venv\Scripts\python.exe smoke_test.py --target-info
```

最后一项仅占用下载器并读取 MCU 标识，不烧录或复位。实测已识别 FireDAP、读取 1024 KiB Flash 和运行中的内核。当前未提供待烧录固件，因此没有执行实板 Flash 改写；编程流程、目标检查及错误路径使用测试替身验证。

补充 API 资料：

- [pyOCD 支持的调试器与 CMSIS-DAP](https://pyocd.io/docs/debug_probes.html)
- [pyOCD 芯片及 CMSIS-Pack 支持](https://pyocd.io/docs/target_support.html)
- [pyOCD Python API 示例](https://pyocd.io/docs/api_examples.html)

本地野火文档、原理图、IO 分配表及其 SHA-256 见 `../../hardware-manuals/stm32-batianhu-v2/model.json`。
