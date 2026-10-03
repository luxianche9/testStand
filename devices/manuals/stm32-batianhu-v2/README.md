# 野火 STM32F407 霸天虎 V2：常用接口模型

按用户确认的范围，仅建立常用外部接线接口。当前为 **14 个接口、197 个触点**；110 个 GPIO 在 CN2/CN3 上完整引出。跳帽不进入接线接口列表，15 组排针整理成 13 条配置记录，其中 BOOT 的 J63/J64/J65 合并为一块 3×2 配置区。

## 范围

| 位号 | 接口 | 触点数 |
|---|---|---:|
| J1 | SWD | 5 |
| J45 | JTAG / SWD | 20 |
| CN2 | GPIO 扩展 A | 60 |
| CN3 | GPIO 扩展 B | 60 |
| J87 | 5V / 3V3 / GND 电源排针 | 8 |
| JACK1 | DC 输入，中心正、外圈地 | 2 |
| J8 | Mini USB 转串口 / 供电 | 5 |
| J24 | Micro USB OTG | 5 |
| J13 | CAN2，板载 120Ω | 2 |
| J15 | RS485，板载 120Ω | 2 |
| CON1 | USART3 RS232 母头 | 9 |
| CON2 | USART2 RS232 公头 | 9 |
| J82 | EBF Module 扩展 | 6 |
| J5 | DHT11 / DS18B20 插座 | 4 |

暂不建模 LCD、摄像头、音频、网口、TF 卡、USB HOST、RTC 电池座。限制说明中仍可能出现这些外设名称，用于说明已建模引脚实际存在的板内共用连接。

DC 座按两个外部电气触点表示，原理图的两个接地焊脚合并为外圈地。排针、DB9 和 USB 按对应连接器触点编号表示；不能用图片观察顺序替代针号。

## 文件

- `hardware.json`：testStand v2 接口和引脚。
- `stm32-batianhu-v2.tshw`：可导入硬件包，包含清单和硬件定义。
- `model.json`：板载常用资源、供电、MCU 引脚复用、跳帽配置、信号共用限制和来源。testStand v2 原生定义只保存端口/针脚，扩展内容只在本文件中。
- `build_model.py`：可重建的来源转录及模型生成器。导出范围由 `COMMON_REFS` 明确限定。

在装有 PyMuPDF、openpyxl 的 Python 环境中重建：

```powershell
python build_model.py --docs 'E:\Project\learnSTM32\doc'
```

## 身份与资料依据

沿用已有硬件 `DUT_1`。原来的 CAN 端口 ID `J1` 和 RS485 端口及针脚 ID 保留，以保持工程引用；名称改为原理图真实位号。因此 **CAN 的历史端口 ID 为 `J1`，但物理位号是 J13；物理 SWD J1 的端口 ID 是 `DUT_1.J1`**。

主要依据：本地 V2 原理图（文件名含 2025）、V2 硬件规格书、V2 IO 分配表、FireDAP 高速款手册。每个接口有原理图页码；源文件路径及 SHA-256 保存在 `model.json`。原理图文件名、版本历史和部分页内日期并不一致，因此用文件哈希固定资料版本。

已记录的资料差异包括 AT24C02 的 2Kbit=256B、主 SPI Flash 的 W25Q64/W25Q128 表述矛盾、CAN/485/232 新旧替代料，以及原理图 MCU 符号 PC0/PC1 内部文字与封装脚号的差异。模型按电气网名、芯片资料和当前原理图综合处理；未把资料推断写成实物检测结果。

接线前应读 `model.json` 中相关限制：USART3 在 RS232/Wi-Fi/EBF 间共用，PA2 在 USART2 与以太网 MDIO 间共用，CAN/音频共用 PB12/PB13，RS485/摄像头共用 PC0。GPIO 是 3.3V 逻辑，RS232 电平不能直接接 GPIO。
