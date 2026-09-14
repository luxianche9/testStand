# HardwareHarness

面向硬件测试与实验室自动化的桌面应用，使用 Python 业务后端与 Electron 前端。

- [应用源码、开发与构建说明](HardwareHarness/README.md)
- [MCP 硬件服务及设备资料](mcp_servers/README.md)
- [本次改名与验证记录](HardwareHarness/reports/rename/README.md)

开发入口：

```powershell
cd HardwareHarness
pnpm install --frozen-lockfile
pnpm python:setup
pnpm dev
```

产品名称为 **HardwareHarness**；包名、Python 模块、环境变量及协议字段使用对应的
`hardwareharness` / `HARDWAREHARNESS` 标识。工程目录为 `.hardwareharness`，硬件文件
扩展名为 `.hhhw`。旧名称的字段与入口不再兼容，也不会自动读取或迁移旧名称的数据目录。

MCP 服务、驱动和硬件模型保留；旧 examples 已移出工作区。
