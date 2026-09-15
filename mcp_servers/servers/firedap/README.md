# FireDAP 本地 STM32 烧录 MCP

基于仓库现有 `cp118u_i` 等 MCP Server 模板的管理契约实现：一个进程、一个 `serverId`、一个受管硬件、结构化结果及安全停机。烧录驱动使用 pyOCD 的 CMSIS-DAP/SWD 接口。

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

首次注册前，在 `hardwareHarness` 目录运行 `pnpm python:setup`，关闭 HardwareHarness，然后用仓库 Electron 运行 `register-hardwareharness.cjs`：

```powershell
# 工作目录为本仓库根目录；若环境中存在 ELECTRON_RUN_AS_NODE，请先移除该变量。
& '.\hardwareHarness\apps\desktop\node_modules\electron\dist\electron.exe' '.\mcp_servers\servers\firedap\register-hardwareharness.cjs'
```

注册由 Python 后端的 DeviceStore、校验规则和硬件包导入实现；Electron 脚本仅启动 Python 并提供 safeStorage 加解密回调。原硬件及凭据先备份到用户目录 `backups/firedap-时间戳`。`DUT_1` 保留原标识、CAN/RS485 端口标识；其他已有硬件不变。然后正常打开 HardwareHarness。

可用 `verify-desktop.cjs` 启动已构建的桌面端进行真实 API 验证；它不开放调试端口，验证后保留正常桌面窗口。报告写入 `run/desktop-verification.json`。

HardwareHarness 的本机服务按钮调用 `start.ps1` / `stop.ps1`。停机先检查没有正在运行的硬件任务，再退出服务；使用进程路径和启动时间验证进程归属。

## 接线

开发板单独供电，FireDAP USB 接本机。用户当前实物使用 **20 芯直通排线：FireDAP JTAG 插座 ↔ 霸天虎 V2 J45**，针脚 1–20 逐号对应；此插座也支持 SWD，本服务使用 SWD 协议。关键针脚为 1/2=VTREF、7=SWDIO、9=SWCLK、15=NRST，其余偶数脚为 GND。FireDAP 的 3/11/17/19 脚为 NC，5=TDI，13=TDO/SWO，SWD 播放测试不使用这些 JTAG/SWO 信号。

另一种可选接法是 5 芯同面排线连接 FireDAP SWD 和开发板 J1（当前实物未使用）：

| 针号 | FireDAP | 霸天虎 V2 J1 |
|---|---|---|
| 1 | VREF，目标参考电压输入 | 3V3 |
| 2 | SWDIO | PA13 |
| 3 | GND | GND |
| 4 | SWCLK | PA14 |
| 5 | NRST | NRST |

VREF 是参考电压，不能默认作为开发板电源。正常运行选择 BOOT0=0。接口编号须对照插座标识和手册，不按照片观看方向猜测。

## 烧录流程

1. 在 HardwareHarness 中确认 FireDAP 硬件在线。
2. 固件不在服务主机允许目录中时，先调用 `firedap_import_firmware(filename, content_base64, expected_sha256)`。它校验 1–32 MiB 的原始字节、SHA-256 和文件扩展名，将内容导入不可覆盖的受管存储，返回 `artifactId/path/sha256`；不访问硬件。随后调用 `firedap_inspect_firmware` 检查返回的服务主机路径。BIN 还需明确 `base_address`，通常为 `134217728`（`0x08000000`）。HEX/IHEX/ELF/AXF 使用文件自带的加载地址。
3. 将返回的 SHA-256 原样传给 `firedap_flash` 的 `expected_sha256`，并提供相同文件路径和地址。
4. 返回的 `jobId` 仅表示已开始。交互查询使用 `firedap_get_job(job_id)`；HardwareHarness 编排使用受管硬件工具 `firedap_wait_job(job_id, timeout_seconds=60)`，直到 `state` 为 `succeeded` 或 `failed`。等待超时仅返回当前状态，不取消底层任务。
5. 只有 `succeeded` 且 `result.verified=true` 才表示烧录及逐字节回读成功。烧录前会先复位并暂停 MCU，清除原应用的外设状态；默认校验成功后复位运行。`reset_after=false` 仅禁止完成后的启动复位，不禁止烧录准备阶段的复位暂停。

`firedap_verify` 只比对已有 Flash；`firedap_target_info` 只连接并读取芯片信息；`firedap_reset` 执行复位。这三者都使用相同的异步任务方式。硬件参数 `hardwareId` 由 HardwareHarness 注入。

| 工具类别 | 工具 |
|---|---|
| 模板管理 | `get_server_info`、`list_hardware`、`get_hardware_info`、`get_pinout` |
| 资料与状态 | `firedap_list_probes`、`firedap_inspect_firmware`、`firedap_get_board_reference`、`firedap_get_job`、`firedap_wait_job` |
| 受管文件 | `firedap_import_firmware`（只存储，不提交硬件动作） |
| 硬件操作 | `firedap_flash`、`firedap_verify`、`firedap_target_info`、`firedap_reset`、`firedap_read_sram`、`firedap_wait_job` |
| HardwareHarness 内部 | `hardwareharness_prepare_shutdown` |

## 行为边界

`firedap_read_sram(address, length=108)` 通过异步任务只读主 SRAM，返回小端 uint32 `words`。地址和长度须按 4 字节对齐，长度为 4–4096 字节，范围限制在 `0x20000000..0x2001FFFF`；不读取外设、Flash 或 CCM。读取采用 attach，不 halt/reset/write，用于播放期间的状态观测。`firedap_wait_job` 可直接等待任务完成。


2026-09-10 的 HardwareHarness 编排运行 `529a2e34-be20-4a9e-9b90-43be7a76ccc8` 已通过：936,944 字节回读一致，45 次采样覆盖 280.398 秒及片尾循环，886 个节点全部成功，播放器、I2C、欠载、解码、DMA 和 HardFault 错误均为 0。画布已保存 FireDAP 20 针接口与霸天虎 V2 J45 的逐针直通连接。

- 仅允许写入 `0x08000000..0x080FFFFF` 的内置 Flash，支持 BIN、Intel HEX、ARM ELF/AXF。其他格式、空文件、重叠段、越界及 SHA 不符均拒绝。
- 通过完整序列号精确选择 CMSIS-DAP，操作前检查 DBGMCU 设备组为 `0x413` 且 Flash 为 1024 KiB。该标识无法单独区分 F405/F407 或封装，板型仍由用户及资料确认。
- 禁止自动解锁读保护，不提供全片擦除或选项字节写入，不支持外置 W25Q128/SRAM 烧录。
- 使用扇区擦除，保留同一扇区内未包含在固件中的字节；烧录成功后独立逐字节回读校验。
- 先读取并校验整个固件快照，再把同一份数据交给工作进程，避免文件在审核后被替换。只接受 `firmwareRoots` 内的文件。
- 有效 `firmwareRoots` 自动包含 `firmwareStagingRoot`；默认位于 `jobDirectory` 同级的 `firmware` 目录。导入使用内容寻址和原子独占创建，相同字节重复导入返回相同标识；既有内容被破坏时拒绝覆盖。文件格式检查和地址验证由后续 inspect 完成。
- 同时只运行一个硬件任务。烧录期间即使客户端断开，任务继续完成或达到超时；此时不能启动第二个硬件任务，服务不会中途正常停机。
- 独立工作进程默认超时 120 秒。超时/USB 断开可能留下部分写入或停止的 MCU，必须检查结果后重试。进程在空目录运行，避免 pyOCD 自动加载工程中的用户脚本。
- 任务结果保存在 `run/jobs`；工具仅查询当前服务会话内最近 100 个任务。重启后历史记录可从文件查阅。

## 发行版契约与参考资料

公开契约修订版为 `2026-09-15.1`。全部 15 个公开工具带有参数描述、界限、类型化输出和副作用 annotations。内部停机接口继续标记为 internal；客户端不应直接调用。

`get_server_info` 和 `get_hardware_info` 返回非敏感有效固件目录、容量/地址限制、SWD 频率、超时与当前会话作业保留规则。发现探针只能证明 USB 枚举，不能证明 SWD 接线、目标供电或程序行为。只读作业提交仍会创建新 job，不能将其当作幂等重试。

板卡长文档可先读 `firedap_get_board_reference(section="index")`，再按返回的 section 名调用并传 `offset/limit`。每页带来源版本、内容 hash、total 和 nextOffset。省略 section 保留旧完整文档结果。资料内的原始 source.path 仅为历史文献出处，不能当作当前服务可读路径或 HH 源码入口。`get_pinout` 支持 connector_id/offset/limit，保持原 pinout 数据结构。

直接 MCP 结果保留 `{ok,data,meta}` / `{ok:false,error,meta}`。HH Agent 网关成功结果为 `{ok:true,data:<设备 data>}`；Python SDK 默认保留 MCP envelope，需要检查 `isError` 和 `structuredContent.ok`。失败和部分效果仍在 error 中，超时不应自动重提烧录或复位。`get_job/wait_job` 只查询原 job；running 的 revision 为 1，终态为 2。

## 验证

```powershell
.\.venv\Scripts\python.exe -m pip install -e '.\app[test]'
.\.venv\Scripts\python.exe -m pytest app/tests -q
.\.venv\Scripts\python.exe smoke_test.py
.\.venv\Scripts\python.exe smoke_test.py --target-info
```

最后一项仅通过下载器读取 MCU 标识，不烧录或复位。

2026-09-10 已通过本服务在霸天虎 V2 上实际烧录《Bad Apple》固件，936,944 字节全部回读一致；用户确认 NT35510 屏幕画面及 WM8978 扬声器音乐正常。工程和备份位于 `E:\Project\learnSTM32\bad_apple`，完整操作结果见该目录 `reports/flash.json`。本次实测修复了 pyOCD 进度输出污染 JSON，以及仅 attach 后未复位暂停就进入 Flash 算法的问题；工作进程将所有非协议输出重定向到 stderr。

补充 API 资料：

- [pyOCD 支持的调试器与 CMSIS-DAP](https://pyocd.io/docs/debug_probes.html)
- [pyOCD 芯片及 CMSIS-Pack 支持](https://pyocd.io/docs/target_support.html)
- [pyOCD Python API 示例](https://pyocd.io/docs/api_examples.html)

本地野火文档、原理图、IO 分配表及其 SHA-256 见 `../../hardware-manuals/stm32-batianhu-v2/model.json`。
