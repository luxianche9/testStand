# 已有设备登记

完成时间：2026-09-14。登记位置：`%APPDATA%/HardwareHarness/devices`。
使用当前 Python DeviceStore、现有模型与 Electron safeStorage 完成一次性登记，未增加旧名称的运行时兼容。

## 已登记设备

| 硬件 | ID | 类型 | 接口 | 触点 | 图片 |
| --- | --- | --- | ---: | ---: | ---: |
| 野火 STM32F407 霸天虎 V2 | `DUT_1` | 被动开发板 | 14 | 197 | 15 |
| 野火 FireDAP | `LOCAL_MCP.FIREDAP_0` | 本机 MCP | 3 | 25 | 2 |
| CP-118U-I 多串口卡 | `PC1_MCP.CP118U_I_CARD_0` | 远程 MCP | 8 | 72 | 9 |
| PCI-1710L 多功能采集卡 | `PC1_MCP.PCI1710L_CARD_0` | 远程 MCP | 1 | 68 | 2 |
| PCI-1762 继电器输出卡 | `PC1_MCP.PCI1762_CARD_0` | 远程 MCP | 1 | 62 | 2 |
| PCI-6208V 模拟量输出卡 | `PC1_MCP.PCI6208V_CARD_0` | 远程 MCP | 1 | 37 | 2 |
| 原库示波器 | `Oscilloscope1` | 被动硬件 | 2 | 4 | 1 |

用户提到的霸天虎 V2，在已有原理图、模型和旧库中均标注为野火（Embedfire）STM32F407ZGT6，
因此采用该模型，没有将其改成正点原子的另一块开发板。
除用户列出的六个设备外，旧库已有的示波器也按“全部已有设备”的范围保留。

电脑关联为 `LOCAL_PC`（本机）与 `REMOTE_PC_1`（会议室一体机，192.168.3.63）。
保留原硬件、接口和触点 ID，33 张图片逐项比对原字节；开发板的扩展资料使用本仓库的
`mcp_servers/hardware-manuals/stm32-batianhu-v2/model.json`。

## 服务与凭据

- CP-118U-I、PCI-1710L、PCI-1762、PCI-6208V 分别连接远程的 8014、8011、8012、8013 端口。
- FireDAP 使用本仓库服务，连接 `127.0.0.1:8015`。沿用已登记探针序列号和实际 CMSIS Pack，
  生命周期命令、资料路径及任务目录已指向当前仓库；已安装独立虚拟环境并启动服务。
- 六项 SSH/MCP 凭据从原设备库解密后，通过当前应用的 safeStorage 密钥重新加密；
  报告不包含密码、token 或密文。当前应用已有的网关凭据和用户设置保留。
- 旧库、归档项目与当前用户新建的 `examples/stm32_example1` 均保留。登记前备份位于
  `%APPDATA%/HardwareHarness/backups/device-registration-20260914T033021Z`。

四个远程服务原先仍暴露旧品牌的工具名与元数据，当前后端会将其工具识别为未知类型。
逐文件确认它们与本地源码仅存在命名差异后，分别更新了 25 个文件。每个服务均在未占用时
备份、正常停止、更新、运行现有 8 项测试、重启并验证连接；原服务配置、凭据、驱动及环境保留。
旧源码移入备份目录，没有作为当前运行模块保留。
各远程备份目录和结果见 [remote-deployment.json](remote-deployment.json)。

## 验证结果

- 真实 Electron → preload → Python 接口确认：7 个硬件、2 台电脑、5 个 MCP 服务。
- 两台电脑检测在线，5 个 MCP transport 在线；FireDAP 探针已通过枚举确认存在。
- 原始 MCP 列表合计 59 个工具，桌面按既有规则隐藏 10 个 internal 工具，显示 49 个工具；
  无未知类型工具。详见 [desktop.json](desktop.json)。
- 四个远程服务的 32 项测试通过，FireDAP 的 36 项测试通过，见 [firedap-tests.txt](firedap-tests.txt)。
- 先前一次桌面 SSH 检测曾超时；最终桌面复核两台电脑均在首次检测成功，未放宽业务超时或修改后端。
- 重新打开原项目并切换至设备管理，桌面保持打开。界面证据见 [devices.png](devices.png)。

验证执行了设备发现、状态与工具列表读取，没有执行固件烧录、擦除或手动输出测试。
本次未改动应用源码，未重跑与设备登记无关的完整编译及移植测试门禁。
