# HardwareHarness 改名交付记录

日期：2026-09-14。改名前参考 revision：`1aaa0a1`。

## 范围与当前名称

本次仅统一产品及其接口命名，继续使用 Python 业务后端和 Electron stdio 转发。
未实施架构 v3、增加硬件功能或重设计页面。

| 项目 | 当前值 |
| --- | --- |
| 应用工作区 | `HardwareHarness/` |
| 产品、窗口、安装包名称 | `HardwareHarness` |
| npm 包作用域 | `@hardwareharness/*` |
| Python 发行包 / 模块 | `hardwareharness-backend` / `hardwareharness_backend` |
| 后端程序 | `hardwareharness-backend.exe` |
| Electron appId | `com.hardwareharness.desktop` |
| 默认应用数据目录 | `%APPDATA%/HardwareHarness` |
| 工程目录 | `.hardwareharness` |
| 硬件 bundle 扩展名 | `.hhhw` |
| renderer 桥接对象 | `window.hardwareharness` |
| 图片协议 | `hardwareharness-asset:` |
| 环境变量前缀 | `HARDWAREHARNESS_` |
| MCP 元数据命名空间 | `_meta.hardwareharness` |
| MCP 租约 / 关闭工具 | `hardwareharness_hardware_occupancy` / `hardwareharness_prepare_shutdown` |
| MCP Python 模块 | `hardwareharness_remote` / `hardwareharness_firedap` |
| FireDAP 登记脚本 | `register-hardwareharness.cjs` |

按用户最新要求，旧名称字段、环境变量、工具名、桥接对象、文件扩展名和工程路径均不提供
兼容别名。不会自动读取或迁移旧名称的应用数据目录。工程内容的既有版本校验与升级规则
仍然存在；它们与旧品牌名称的兼容是不同事项。

## MCP 与 examples

五个 MCP 服务完整保留：CP-118U-I、PCI-1710L、PCI-1762、PCI-6208V、FireDAP。
[逐文件保存清单](mcp-preservation.json)核对了原有 196 个受 Git 管理的文件及对应新路径，
所有原文件均有对应项，二进制驱动、图片及 bundle 内容保持原字节。

旧 examples 已移出工作区，可恢复归档位于仓库 `.git/retired-examples`，不会加入提交或安装包。
直接删除曾被自动审批以“blocked by policy”拦截，工具未提供更具体原因，因此采用了可恢复归档。

## 验证证据

| 检查 | 结果 | 记录 |
| --- | --- | --- |
| ruff、格式、mypy strict、Python 全量测试 | 859 项通过 | [python.txt](python.txt) |
| 原规格与覆盖率门禁 | 117 个包用例 + 3 个迁移用例映射、八包覆盖门槛、110 项保护文件通过 | [python.txt](python.txt) |
| TypeScript `pnpm verify` | 类型、lint、219 个测试、导入/命名/依赖检查、生产构建通过 | [typescript.txt](typescript.txt) |
| TypeScript 覆盖率检查 | 219 个测试通过，阈值未降低 | [typescript-coverage.txt](typescript-coverage.txt) |
| Electron E2E | 27 项通过 | [e2e.txt](e2e.txt) |
| 冻结 Python 后端、隔离运行环境 | 6 项通过 | [frozen-tests.txt](frozen-tests.txt) |
| FireDAP | 36 项通过 | [firedap.txt](firedap.txt) |
| 其余四个 MCP 服务 | 各 8 项，共 32 项通过 | [CP-118U-I](cp118u_i.txt)、[PCI-1710L](pci1710l.txt)、[PCI-1762](pci1762.txt)、[PCI-6208V](pci6208v.txt) |

E2E 覆盖工程打开、手动工具调用、Run 日志与重启、接线确认、占用请求、safeStorage、退出
无孤儿后端、键盘操作、弹窗与画布交互，以及三种主题、三种尺寸。
截图位于 [visual/rename](../shadcn/visual/rename)，已抽查界面产品名称。

改名移动目录后重新安装了锁定依赖和 Python 环境。Electron 自动安装未产出完整运行文件，
使用本机归档工作区已有的同版本 Electron 36.9.5 文件补齐；未修改归档工作区。
首次验证还曾因输出日志本身被纳入构建前后比较而失败，最终验证日志改在 Git 管理目录生成，
构建成功后再复制至本报告目录，未放宽“构建不修改受管理文件”的检查。

## 历史名称保留范围

历史规格、golden、测试报告、旧截图及其 SHA 固定证据不改写，避免伪造原测试结果。
历史 oracle 读取脚本仍需识别历史 checkout 的包名和路径；一个原用例名称仍用于映射历史断言。
storage golden 的加载器仅在测试输入与期望路径中转换工程目录名称，golden 原字节未改。
这些均不属于生产兼容逻辑。

[保护范围的改名清单](protected-changes.json)记录前后哈希及授权来源，保留上一阶段基线。
新增 `check:branding` 已进入 `pnpm verify`，防止旧品牌重新进入前后端、契约与 MCP 服务的
有效源码；第三方依赖、生成缓存和历史证据不计为当前运行源码。

## 安装包验收

安装包：[HardwareHarness-0.1.0-windows-x64.exe](../../dist/HardwareHarness-0.1.0-windows-x64.exe)。
大小为 222,731,928 字节；SHA-256：

```text
de0cf1c329f15613336d6036826296afc1c5dce0e9e8f282d86867e4ab3b7d7a
```

[打包记录](package.txt)。本次打包显式使用已安装的 Electron 36.9.5 分发目录
（`electron-builder -c.electronDist=...`），避免再次下载相同运行文件；发行配置未改变版本。
已检查安装包内的应用包名、main/preload/renderer 入口及文件名，不含旧品牌标识。

[本机安装冒烟](installed.txt)通过：安装到含中文和空格的目录，设置只读权限并确认写入被拒绝，
清除启动环境中的 Python/uv 路径后打开程序，验证 safeStorage 密文、单个 Python 后端及退出
无孤儿进程，随后卸载临时安装。安装与卸载均成功。

独立干净 Windows 与实际断网验收尚未执行；本机环境隔离测试不等同于这两项验收。
