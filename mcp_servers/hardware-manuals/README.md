# 四块板卡资料

这些 PDF 用于人工查看和截取接线管理所需的硬件、端口图片，不会进入 AI Agent 或 MCP 工具上下文。

## 推荐截图页

| 硬件 | 文档 | 推荐 PDF 页 | 内容 |
| --- | --- | ---: | --- |
| PCI-1710L | `Advantech_PCI-1710_Series_User_Manual.pdf` | 32 | 68 针 I/O Connector 完整针脚图，并注明 PCI-1710L 的 AO 相关针脚未定义 |
| PCI-1762 | `Advantech_PCI-1762_User_Manual_Edition_1.pdf` | 16 | 62 针 I/O Connector 完整针脚图 |
| PCI-6208V | `ADLINK_PCI-cPCI-6208-6216-GL_User_Manual_Rev_4.02.pdf` | 23 | PCI-6208V 的 37 针 CN1 图，与 PCI-6216V 对照图 |
| CP-118U-I | `Moxa_CP-118U-138U_QIG_v6.pdf` | 2 | Male DB9 在 RS-232、RS-422/4-wire RS-485、2-wire RS-485 下的针脚表 |

## 来源

- PCI-1710 Series User Manual: Advantech 下载站，`pci-1710-11-16.pdf`
- PCI-1762 User Manual Edition 1: Advantech 手册归档镜像，手册内型号和针脚图已核对
- PCI/cPCI-6208/6216-GL Series User Manual Rev. 4.02: ADLINK 厂商手册归档镜像，修订历史包含 3.22，PCI-6208V 针脚图已核对
- CP-118U/138U Series Quick Installation Guide v6: Moxa QIG v6 镜像，Sixth Edition, May 2009

截图后可在 HardwareHarness 接线管理的硬件库中展开对应硬件：

1. 上传整块板卡或设备照片作为“硬件外观图”。
2. 上传从上述页面截取的端口针脚图作为 Connector 的“端口图”。
3. HardwareHarness 不校验图片内容，只在人工接线确认弹窗中展示端口图。
