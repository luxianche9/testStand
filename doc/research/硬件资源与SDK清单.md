# 硬件资源与 SDK 调用清单

整理日期：2026-09-19

源码位置：`E:\Project\归档\customTest`

本清单覆盖 `MPro`、`FKsoftProgram_CVI`、`总线接口显示控制模块测试设备测试软件`、`NjRIUTestEQU` 四个项目，依据源码、工程依赖、设备初始化和随附硬件配置数据库整理。

## 1. 统计口径

以软件控制的台架硬件和通信接口为统计对象，列出硬件用途、SDK 或通信方式、代表性调用及使用状态。被测产品内部的 CPU、存储器、FPGA 等自检资源，在末尾说明其访问方式。

- **当前使用路径**：现有源码中具有设备初始化、业务调用或配置绑定。仅确认软件接入关系，未连接实物验证。
- **保留路径**：存在适配代码、协议或配置，但当前初始化未启用，或调用入口已注释。
- **仅附带库文件**：目录中存在 DLL、LIB 或头文件，尚未找到项目调用证据，不能据此认定硬件在用。

数量和端口来自当前归档代码及配置，不能直接视为实物资产盘点结果。表中的接口是代表性调用，未逐项枚举 SDK 导出的全部函数，也不表示每个测试用例都会执行这些接口。

SDK（Software Development Kit，软件开发工具包）与设备协议分别标明。VISA（Virtual Instrument Software Architecture，虚拟仪器软件架构）提供通用仪器访问接口；SCPI（Standard Commands for Programmable Instruments，可编程仪器标准命令）定义仪器命令。通过 VISA 或串口发送 SCPI 的设备，可能没有调用独立的型号专用 SDK。

## 2. MPro

技术环境：Qt / C++。

### 2.1 硬件及调用关系

| 硬件资源 | 数量或资源配置 | 用途 | SDK / 通信方式 | 代表性调用 |
| --- | --- | --- | --- | --- |
| SPDT4801 继电器开关卡 | 代码打开设备 0；定义 48 路 | 继电器通道切换 | `SPDT4801_JC.dll`、`SPDT4801_JC.lib`、`SPDT4801_JC_lib.h` | `SPDT4801_JC_OpenDev`、`SPDT4801_JC_ResetDev`、`SPDT4801_JC_Switch_SetSingleStatus`、`SPDT4801_JC_CloseDev` |
| RSX8 多通道串口卡 | 代码打开设备 0；使用通道 0～5、7 | RS232、RS422、RS485 通信 | `RSX8_JC.dll`、`RSX8_JC.lib`、`RSX8_JC_lib.h` | `RSX8_JC_Channel_SetMode`、`RSX8_JC_Channel_SetCommState`、`RSX8_JC_Tx_Channel_Write`、`RSX8_JC_Rx_Channel_Read`，以及定时发送接口 |
| 28DC-JS，28 V 电源及状态接口 | 使用 RSX8 通道 7 | 电源开关，读取电压、电流和光耦状态 | 经 RSX8 发送自定义 RS422 二进制命令；未发现独立电源 SDK | 项目 `on28VButtonClicked`、`deal28VRSData`，底层调用串口卡发送、接收接口 |
| 主机以太网接口及网络对端 | UDP 对端配置为 `192.168.3.34:8080`，本地端口为 8081 | UDP 通信及网络连通性检查 | Qt Network；部分检查经系统命令执行 | `QUdpSocket`、`QNetworkInterface`、`QProcess` |

### 2.2 串口分配

| RSX8 通道 | 工作模式 | 波特率 | 校验 | 用途 |
| --- | --- | --- | --- | --- |
| 0～3 | RS232 | 115200 | 无校验 | 被测产品串口通信 |
| 4～5 | RS485 | 115200 | 无校验 | 被测产品串口通信 |
| 7 | RS422 | 115200 | 偶校验 | 28 V 电源控制与状态读取 |

`SDCardManager` 是项目对继电器开关卡的封装类名，其内部调用 `SPDT4801_JC` SDK。代码未显示该类涉及存储卡访问。

源码依据：

- [工程 SDK 链接配置](E:/Project/归档/customTest/MPro/MPro.pro:17)
- [继电器卡封装](E:/Project/归档/customTest/MPro/SDCardManager.cpp:17)
- [串口卡封装](E:/Project/归档/customTest/MPro/RSCardManager.cpp:49)
- [串口分配与电源控制](E:/Project/归档/customTest/MPro/MMainWindow.cpp:515)
- [UDP 对端配置](E:/Project/归档/customTest/MPro/Window.cpp:221)
- [UDP 通信实现](E:/Project/归档/customTest/MPro/udp/udpmanager.cpp:17)

## 3. FKsoftProgram_CVI

技术环境：NI LabWindows/CVI / C。

### 3.1 硬件及调用关系

| 硬件资源 | 数量或资源配置 | 用途 | SDK / 通信方式 | 代表性调用 |
| --- | --- | --- | --- | --- |
| 1553B 总线板卡，具体型号未注明 | 设备 0、通道 0 | 总线控制、消息发送和监视 | `MIL1553B.dll`、`MIL1553B.lib`、`MIL1553B_lib.h` | `M1553_OpenDev`、`M1553_BC_Init`、`M1553_BC_WriteMsgCB`、`M1553_BC_Start`、`M1553_BC_ReadMsgBuf`、`M1553_BM_Init` 等 |
| CHR44202_24 离散量板卡 | 设备 0 | 离散量输入、输出 | `CHR44X02.dll`、`CHR44X02.lib`、`CHR44X02_lib.h` | `CHR44X02_OpenDev`、`CHR44X02_IO_SetOutputStatus`、`CHR44X02_IO_GetInputStatus` |
| PXI-RS422 串口卡，使用 CHR34XXX 系列接口 | 设备 0；初始化 8 路 RS422，500 kbit/s、奇校验 | 多路串口通信 | `CHR34XXX.dll`、`CHR34XXX.lib`、`CHR34XXX_lib.h` | `CHR34XXX_Ch_SetMode`、`CHR34XXX_Ch_SetCommState`、`CHR34XXX_TxCh_Write`、`CHR34XXX_Asyn_RxCh_Read` |
| TDK-Lambda 可编程电源 | 3 台，共用 COM2，设备地址为 6、7、8 | 电压、电流、输出开关和保护参数控制，读取测量值 | NI LabWindows/CVI 串口库 `rs232.h`，加项目 `TDK_Pwr_*` 协议封装；未发现独立 TDK SDK | `OpenComConfig`、`ComWrt`、`ComRdTerm`；发送 `ADR`、`PV`、`PC`、`OUT`、`MV?`、`MC?` 等命令 |

### 3.2 说明

TDK 电源串口配置为 9600 bit/s、8 数据位、无校验、1 停止位。归档代码没有明确给出三台电源的完整型号。

`MIL1553B` 是 SDK 文件名，实际函数前缀为 `M1553_`。`CHR34XXX` 表示代码所使用的 SDK 系列，不能单独据此确定串口卡的完整订货型号。

源码依据：

- [1553B 板卡初始化](E:/Project/归档/customTest/FKsoftProgram_CVI/CHR1553B.c:77)
- [离散量板卡封装](E:/Project/归档/customTest/FKsoftProgram_CVI/CHR44202_24.c:16)
- [RS422 板卡封装](E:/Project/归档/customTest/FKsoftProgram_CVI/CHR_RS422.c:25)
- [8 路 RS422 初始化](E:/Project/归档/customTest/FKsoftProgram_CVI/FKsoftTest.c:1903)
- [TDK 电源命令封装](E:/Project/归档/customTest/FKsoftProgram_CVI/TDK_Pwr_Ctrl.c:7)
- [TDK 电源地址与测量](E:/Project/归档/customTest/FKsoftProgram_CVI/FKsoftTest.c:478)
- [TDK 串口初始化](E:/Project/归档/customTest/FKsoftProgram_CVI/FKsoftTest.c:571)

## 4. 总线接口显示控制模块测试设备测试软件

技术环境：NI LabWindows/CVI / C。硬件配置同时参考随附的 `资源配置.accdb`。

### 4.1 硬件及调用关系

| 硬件资源 | 数量或资源配置 | 用途 | SDK / 通信方式 | 代表性调用或命令 |
| --- | --- | --- | --- | --- |
| JCXD-IMIO-X-4801 离散量卡 | 数据库启用 1 张 | 离散量输入、输出 | `IMIO4801_JC.dll/.lib`、`IMIO4801_JC_lib.h` | `IMIO4801_JC_IO_GetInputStatus`、`IMIO4801_JC_IO_SetOutputStatus` |
| JCXD-DIO-X-9601 数字 I/O 卡 | 数据库启用 1 张 | 数字信号采集、输出 | `DIO9601_JC.dll/.lib`、`DIO9601_JC_lib.h` | `DIO9601_JC_IO_CreateDOChan`、`DIO9601_JC_IO_WriteDOChan`、`DIO9601_JC_IO_ReadDIChan` |
| JCXD-U429 总线卡 | 数据库启用 1 张，配置 16 路发送通道 | ARINC 429 通信 | `A429_JC.dll/.lib`、`A429_JC_lib.h` | `A429_JC_Tx_Channel_Init`、`A429_JC_Tx_Channel_Write`；封装还实现了接收通道配置和读取 |
| JCXD-1553 总线卡 | 数据库启用 1 张 | 1553B 通信 | `A1553B_JC.dll/.lib`、`A1553B_JC_lib.h` | `A1553B_JC_BC_Init`、`A1553B_JC_BC_WriteMsgCB`、`A1553B_JC_BM_ReadMsgBuf`、`A1553B_JC_RT_Init` 等 |
| RS232 / RS422 串口接口资源 | 21 个 RS232 配置端口；24 个 RS422 配置端口 | 被测产品、仪器和调理板通信 | NI LabWindows/CVI 串口库；串口扩展硬件型号未注明 | `OpenComConfig`、`ComWrt`、`ComRd`、`InstallComCallback`、`CloseCom` |
| DP822A 电源 | 2 台，COM28、COM29 | 双通道供电 | CVI 串口库＋SCPI；无独立型号专用 SDK 调用 | `:APPL`、`:OUTP`、`:MEAS:ALL?` |
| DP711 电源 | 2 台，COM30、COM31；配置名为 `DP711A1/2` | 单通道供电 | CVI 串口库＋SCPI；无独立型号专用 SDK 调用 | `:APPLy`、`:OUTPut`、`:MEASure?` 等 |
| 电源调理板 | 8 块，COM52～COM59 | 控制 ±5 V、±15 V、28 V 支路，读取电压、电流 | CVI 串口库＋自定义二进制协议 | 项目 `SendDC1Card`～`SendDC8Card`、`ReadDC1Card`～`ReadDC8Card` |
| HD CROSSPOINT VGA1616 V3.01 视频矩阵 | 1 个控制端口，COM14 | 视频通道切换 | CVI 串口库＋矩阵文本协议 | 发送形如 `1V1.` 的切换命令 |
| 主机显示输出 | 视频测试画面输出 | 提供视频测试画面 | Windows 显示相关接口及项目封装 | `GetMonitorInfo`、项目 `SetWallpaper` |
| USB 校准测量仪器，具体型号未明确 | 保留 VISA 配置与校准测量代码；当前初始化调用已注释 | 直流电压等测量 | VISA，使用 `visa.h` | `viOpenDefaultRM`、`viOpen`、`viPrintf`、`viScanf`、`viClose`；`MEAS:VOLT:DC?` |

数据库的四条板卡记录均将厂商填写为“凯锐测控”。该厂商信息来自项目配置，未另行核对实物铭牌。

### 4.2 串口资源构成

| 资源组 | 配置数量 | 连接对象 | 通信参数 |
| --- | --- | --- | --- |
| RS232 被测产品串口 | 8 | UUT1～UUT8 | 115200 bit/s，8N1 |
| RS232 可编程电源串口 | 4 | 2 台 DP822A、2 台 DP711 | 9600 bit/s，8N1 |
| RS232 视频矩阵串口 | 1 | 视频矩阵 | 9600 bit/s，8N1 |
| RS232 电源调理板串口 | 8 | 电源调理板 1～8 | 460800 bit/s，8N1 |
| RS422 命令串口 | 8 | 每个被测产品 1 个命令口 | 9600 bit/s，8N1 |
| RS422 测试串口 | 16 | 每个被测产品 2 个测试口 | 9600 bit/s，8N1 |

`8N1` 表示 8 数据位、无校验、1 停止位。21 个 RS232 配置端口已经包含电源、矩阵、调理板端口，不能重复累加为独立设备数量。

以上端口构成依据 `01_RS232串口配置表`、`02_RS422串口配置表` 及对应业务代码。数据库还保留 `03_电源串口配置表`，其中存在另一组调理板记录；未将这组记录额外计作一套在用硬件。

### 4.3 视频与校准路径说明

VGA/LVDS 切换同时涉及视频矩阵控制和被测模块命令：`Pocotol_LVDSSwitch` 向矩阵串口发送切换命令，并通过 `RS422_CMD` 向被测模块发送自定义命令。

`VideoForm.c` 中还保留了“迈拓维矩阵”的旧切换函数，但其对应业务调用被注释，当前路径发送的是 HD CROSSPOINT 的切换命令。

USB 校准仪器在 `config.ini` 中有 VISA 资源地址，校准封装中有测量调用；`Adjust_InitVISA` 内的 `VISA_Init()` 已注释。因此只能确认保留了这一接入路径，不能认定当前版本会正常打开该仪器。

源码和配置依据：

- [板卡初始化与型号匹配](E:/Project/归档/customTest/总线接口显示控制模块测试设备测试软件/源代码/设备驱动/HardWare.c:136)
- [串口库封装](E:/Project/归档/customTest/总线接口显示控制模块测试设备测试软件/源代码/设备驱动/SerialTool.c:19)
- [可编程电源测量与控制](E:/Project/归档/customTest/总线接口显示控制模块测试设备测试软件/源代码/操作界面/MainForm.c:781)
- [电源调理板控制](E:/Project/归档/customTest/总线接口显示控制模块测试设备测试软件/源代码/操作界面/PowerCtrlForm.c:99)
- [视频矩阵型号与控制命令](E:/Project/归档/customTest/总线接口显示控制模块测试设备测试软件/源代码/操作界面/VideoForm.c:251)
- [VGA/LVDS 切换协议](E:/Project/归档/customTest/总线接口显示控制模块测试设备测试软件/源代码/操作界面/ComProtocol.c:611)
- [校准仪器初始化状态](E:/Project/归档/customTest/总线接口显示控制模块测试设备测试软件/源代码/公用模块/AdjustForm.c:496)
- [硬件资源配置数据库](E:/Project/归档/customTest/总线接口显示控制模块测试设备测试软件/应用程序/资源配置库/资源配置.accdb)
- [校准仪器 VISA 配置](E:/Project/归档/customTest/总线接口显示控制模块测试设备测试软件/应用程序/资源配置库/config.ini)

## 5. NjRIUTestEQU

技术环境：Qt / C++。当前 `DeviceSglt::Init()` 初始化 15 类设备、17 个设备实例，其中 THC031B、THC032A 各创建两个实例。

### 5.1 当前初始化的硬件

表中“总线/槽位”为代码传入的 PCI 总线号和设备槽位参数，格式为 `(bus, slot)`。

| 硬件资源 | 数量 / 连接 | 用途 | SDK / 通信方式 | 代表性调用 |
| --- | --- | --- | --- | --- |
| THC001B | 1 张，`(4, 9)` | 同步模拟量采集 | `THC001B.dll/.lib`、`THC001B.h` | `THC001B_OpenDevice`、`THC001B_SampleCallBackRegister`、`THC001B_StartSample`、`THC001B_StopSample` |
| THC012B | 1 张，`(4, 14)` | 96 路离散量输出 | THC012B SDK；归档含 `THC012Bd.dll/.lib`、`THC012B.h` | `THC012B_OpenDevice`、`THC012B_SetDiscreteCrtl` |
| THC031B | 2 张，`(5, 11)`、`(5, 12)` | 连续电压采集 | `THC031B.dll/.lib`、`THC031B.h` | `THC031B_OpenDevice`、`THC031B_GetValue` |
| THC032A | 2 张，`(5, 13)`、`(5, 14)` | 模拟电压、频率输出；第二张初始化为频率输出模式 | `THC032A.dll/.lib`、`THC032A.h` | `THC032A_SetOutput`、`THC032A_SetWorkMode`、`THC032A_SetModeAll` |
| THC032C | 1 张，`(4, 11)` | 单端、差分电压输出 | THC032C SDK；归档含 `THC032Cd.dll/.lib`、`THC032C.h` | `THC032C_SetOutput`、`THC032C_SetDiffOutput`、`THC032C_SetSeDiffMode` |
| THC053A | 1 张，`(5, 15)` | 电容模拟、激励与采样、故障设置 | THC053A SDK；归档含 `THC053Ad.dll/.lib`、`THC053A.h` | `THC053A_SetCapValue`、`THC053A_SetCapValueEx`、`THC053A_GetSampleInfo`、`THC053A_SetFault` |
| THC092A | 1 张，`(4, 13)` | LVDT 位移传感器模拟及采集 | THC092A SDK；归档含 `THC092Ad.dll/.lib`、`THC092A.h` | `THC092A_SetDACVol`、`THC092A_SetLvdtPosration_S1`、`THC092A_SetLvdtSampleEn`、`THC092A_GetLvdtSampleValue` 等 |
| THC103A | 1 张，`(4, 15)` | 多路 RS232 / RS422 / RS485 通信 | `THC103A.dll/.lib`、`THC103A.h` | `THC103A_SetUartConfig`、`THC103A_SendUartData`、`THC103A_ReadUartData` |
| THC123A | 1 张，`(5, 9)` | 1394 总线通信 | `Mil1394Libd.dll/.lib`、`Mil1394Lib2.h`、`Prot1394Def.h` | `CreateMil1394Obj`、`OpenDevice`、`NodeInit`、`SendPreAsyncMsg`、`SendPreStofMsg`、接收回调 |
| CHRU45202 继电器开关卡 | 1 张，`(4, 10)`，功能号 0 | 信号路由、开关控制 | `CHR45X02.dll/.lib`、`CHR45X02_lib.h` | `CHR45X02_OpenDevEx`、`CHR45X02_Relay_SetSingleStatus`、`CHR45X02_Relay_GetSingleStatus` |
| IT6522D 电源 | 1 台，USB VISA 连接 | 产品功率供电 | VISA，代码链接 `visa64.lib`；通过项目 `VisaBase` 发送 SCPI | `viOpenDefaultRM`、`viOpen`、`viWrite`、`viRead`；`CURRent`、`VOLTage`、`OUTPut`、`MEASure:*` |
| IT6952A 电源 | 1 台，USB VISA 连接 | 产品供电 | VISA＋SCPI，与 IT6522D 共用 `VisaBase` | 电压、电流设置和测量，输出开关及保护命令 |
| IT8513G 电子负载 | 1 台，COM9，115200 bit/s | 恒流、恒压、恒阻、恒功率负载 | Qt SerialPort＋SCPI；项目 `CSerial` 封装 | `CURR`、`VOLT`、`RES`、`POWer`、`INPut`、`MEASure:*` |
| SPPS605D 电源 | 1 台，COM6 | 离散量供电 | Qt SerialPort＋设备文本协议；项目 `CSerial` 封装 | 输出命令 `<07000000000>` / `<08000000000>`，以及电压、电流设置和读取命令 |
| ZT DA/TTL 综合模块 | 1 台，COM5，115200 bit/s | 12 路模拟输出、72 路 TTL、34 路继电器 | Qt SerialPort＋自定义二进制协议；未发现独立模块 SDK | 项目 `SetDAParam`、`EnableDAChn`、`TTLConfig`、`RelayConfig`，底层为 `QSerialPort::write`、`readAll` 等 |

LVDT（Linear Variable Differential Transformer，线性可变差动变压器）是位移传感器类型。表中 `SetLvdtPosration_S1` 等函数按源码中的实际拼写保留。

部分 SDK 文件名末尾的 `d` 是归档中的调试版本命名。设备型号、项目封装类名和库文件名需要分别核对，例如 THC123A 调用 `Mil1394Libd`，CHRU45202 调用 `CHR45X02`。

### 5.2 通用通信层

| 通信层 | 使用对象 | 底层依赖 | 说明 |
| --- | --- | --- | --- |
| `VisaBase` | IT6522D、IT6952A | `visa.h`、`visa64.lib` | 通过 USB VISA 资源访问仪器并收发 SCPI；归档未据此确定实际安装的 VISA 运行时厂商及版本 |
| `CSerial` | IT8513G、SPPS605D | Qt SerialPort | IT8513G 使用 SCPI，SPPS605D 使用其设备文本协议 |
| ZT DA/TTL 模块内部串口封装 | ZT DA/TTL 综合模块 | Qt SerialPort | 自行组装、发送和解析二进制帧 |

IT8513G 当前初始化参数为 `COM9`。源码还保留了旧 TCP/IP 地址注释，不能将该注释作为当前接入方式。

源码依据：

- [当前设备初始化及连接参数](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DeviceSglt.cpp:18)
- [设备用途与实例声明](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DeviceSglt.h:45)
- [VISA 底层实现](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/pubSrc/VisaCtrl.cpp:5)
- [通用串口实现](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/pubSrc/Serial.cpp:26)
- [IT8513G 串口与 SCPI](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_IT8513G.cpp:59)
- [SPPS605D 设备协议](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_SPPS605D.cpp:59)
- [THC123A 的 1394 SDK 调用](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_THC123A.cpp:8)
- [综合模块通道资源定义](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_ZTDA_TTL.h:17)

### 5.3 当前未启用的旧硬件适配

下表覆盖归档中保留的硬件适配代码。部分文件仍列入工程，部分仅保存在目录中；当前 `DeviceSglt::Init()` 没有启用这些设备路径。

| 保留的硬件或适配方案 | 用途 | 对应 SDK / 接口 | 源码 |
| --- | --- | --- | --- |
| CHR41201 | 同步模拟量采集 | `ADIX0801S.dll/.lib`；`ADIX0801S_AD_*` | [DevOpt_CHR41201.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_CHR41201.cpp) |
| CHR41202_2S | 模拟量采集 | `ADX6401.dll/.lib`；`ADX6401_AD_*` | [DevOpt_CHR41202_2S.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_CHR41202_2S.cpp) |
| CHR42201-5S | 模拟量输出 | `DAX6401.dll/.lib`；`DAX6401_DA_Output` | [DevOpt_CHR42201-5S.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_CHR42201-5S.cpp) |
| CHR42202_S0 | 差分电压输出 | `CHR42X02.dll/.lib`；`CHR42X02_DA_WriteVoltage` | [DevOpt_CHR42202_S0.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_CHR42202_S0.cpp) |
| CHR42203S-EX | 波形、频率输出及数字 I/O | `DAX0801SEX1.dll/.lib`；正弦、方波、三角波及 I/O 接口 | [DevOpt_CHR42203S-EX.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_CHR42203S-EX.cpp) |
| CHR47203 | LVDT 模拟 | `VDTOX0401.dll/.lib`；`VDTOX0401_Update_LVDT_Channel` | [DevOpt_CHR47203.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_CHR47203.cpp) |
| THC001A | 同步模拟量采集 | `THC001A.dll/.lib` | [DevOpt_THC001A.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_THC001A.cpp) |
| THC031A | 电压采集 | `THC031A.dll/.lib` | [DevOpt_ZT_THC031A.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_ZT_THC031A.cpp) |
| WD6671 | 电容模拟和采集 | `WDCapactior.dll/.lib`；`WDCapactior_SetChSimCap`、`WDCapactior_ReadADCData` | [DevOpt_WD6671.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_WD6671.cpp) |
| ZTDiscrete96 | 96 路离散量控制 | PLX SDK，通过寄存器读写控制 | [DevOpt_ZTDiscrete96.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_ZTDiscrete96.cpp) |
| ZT_16UART | 多路串口通信 | PLX SDK，通过寄存器与 DMA 收发 | [DevOpt_ZT_16UART.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_ZT_16UART.cpp) |
| THC092A 旧版直接访问实现 | LVDT 模拟及采集；同型号的另一套适配实现 | PLX SDK，通过寄存器与 DMA 操作 | [DevOpt_ZT_THC092A.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_ZT_THC092A.cpp) |
| 旧 CPCI1394 适配代码 | 1394 总线通信 | `Mil1394Libd.dll/.lib` | [DevOpt_CPCI1394655.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/DevOpt_CPCI1394655.cpp) |

`WDCapactior` 为归档中的实际文件和函数拼写。

PLX 公共层使用 `PlxApi.lib`、`PlxApi820_x64.dll`，代表性调用包括：

- `PlxPci_DeviceFind`、`PlxPci_DeviceOpen`、`PlxPci_DeviceClose`：查找、打开和关闭设备。
- `PlxPci_PciBarSpaceRead`、`PlxPci_PciBarSpaceWrite`：访问设备寄存器空间。
- `PlxPci_DmaChannelOpen`、`PlxPci_DmaTransferUserBuffer`：配置 DMA 并传输数据。

DMA（Direct Memory Access，直接内存访问）用于板卡与主机内存之间的数据传输。上述公共层实现见 [CPCIDeviceNew/DeviceClass.cpp](E:/Project/归档/customTest/NjRIUTestEQU/NjRIUTestEQU/CPCIDeviceNew/DeviceClass.cpp:81)。

## 6. 仅附带文件及无法确认的硬件

| 项目 | 附带内容 | 核对结果 |
| --- | --- | --- |
| 总线接口显示控制模块测试设备测试软件 | `nport.dll`、`Nport.lib`、`NPortb.lib` | 应用程序目录附带这些文件，未发现项目直接调用 NPort SDK 的证据。当前源码通过 CVI 串口库访问 COM 口，实际串口扩展设备型号仍需设备资料确认 |
| NjRIUTestEQU | `CHR42X01`、`CHR42X03SEx`、`CHR43X04`、`CHR44X06`、`CHR44X07`、`CHR47X01`、`CHRD0026`、`CHRD0089`、`CHRSERIAL`、`MAD3X04`、`YSApi650` 等库文件 | 未找到相应的项目业务调用证据，不计入当前硬件清单。名称相近的硬件封装应以上文实际调用的库为准 |
| FKsoftProgram_CVI | `HAS_FPGA_CARD` 宏及相关数据结构 | 仅凭宏和数据结构无法确定额外 FPGA 板卡的型号及其 SDK，不额外计作已确认设备 |

## 7. 被测产品内部资源与核对边界

项目包含 CPU、存储器、FPGA、接口和自检等测试项。这些资源主要由被测产品自身执行诊断，上位机通过串口、1553B、1394 等链路发送命令并读取结果。未发现上位机直接调用上述芯片的独立 SDK。

本次完成的是源码和随附配置层面的核对，未进行项目构建、设备枚举或实物联调。仍需实物资料才能确认的内容包括：未注明的完整硬件型号、实际装机数量、串口扩展设备型号，以及目标机器安装的驱动和 VISA 运行时版本。

文中的源码链接指向原归档目录。迁移源码目录后，需要相应更新这些链接。
