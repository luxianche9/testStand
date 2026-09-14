# TS 业务后端删除与 shadcn 中性主题交付

七个 TS 业务包已从当前源码和生产安装包移除。Electron 继续启动 Python 后端，contracts 提供纯类型契约；renderer 换为官方 shadcn New York / neutral 外观。Python 业务源码、数据格式、RPC、OpenCode main 文件和依赖补丁保持本阶段开始时的内容。未提交或回退用户的上一阶段成果。

参考 Git revision：`0b90bfc1b1c4cccc6ebba29666343ec84c494824`（后端 Python 实现）。原移植阶段的记录继续保存在 [历史交付报告](../../python/reports/implementation.md)，其中旧源码保留、renderer 冻结和旧安装包的描述属于上一阶段。

## 删除与契约

- 删除 storage、devices、projects、wiring、orchestration、application、mcp-gateway，以及旧 main migrations 源码和测试，共 **102 个跟踪文件**；同时移除七包的 234 个生成文件。完整 [删除清单](deleted-files.json)。
- `contracts/application.ts` 保存原 `TestForgeApplication` 七个 namespace 的公共签名，包括 RequestContext、可选参数、同步返回、Promise 和二进制类型。Python proxy 从此接口派生类型。
- 在旧源码还存在时完成双向静态兼容断言并运行 typecheck，通过后才删除。证据：[完整断言](contract-type-assertions.txt)、[类型检查](contract-type-compatibility.txt)、[测试结果](contract-runtime-compatibility.txt)。未用 any 或 desktop facade 的不同签名替代原接口。
- 已清除失效 workspace dependencies、TS build references、Vitest projects、externalization、knip 和 dependency-cruiser 项；七包加入禁止导入集合。仍被平台层使用的依赖保留。锁文件的 frozen install 通过。
- [安装包内容核对](packaged-audit.txt) 确认无七包业务模块；363 个打包输出文件与实际测试的构建文件逐字节相同。当前七个目录除忽略的依赖缓存与空目录外无文件。

## 原规格与 Python 门禁

原 **117 个包用例 + 3 个 main 迁移用例**固定为历史规格。三个迁移用例的全部 14 个原断言已纳入 Python 测试及映射。固定证据包含原断言、85 个源文件的 Git／工作区哈希、参考 revision、原始结果、8 个 golden 文件、覆盖率基线和原保护记录。

- [固定规格 manifest](../../python/reports/original-specification-evidence.json)，SHA-256：`6d49c1d2025c6d1459555fd5098f433363109b865b89f387f961b666b5c1a35f`。
- [120 项测试映射](../../python/reports/specification-map.json)、[旧 main 迁移原断言](../../python/reports/ts-migration-assertion-inventory.json)、[原源码哈希](../../python/reports/original-source-hashes.json)。
- 常规门禁只读固定 golden，不需要已删除的源码。三个 oracle 生成器显式要求 `--reference-root` 指向历史 checkout。当前工作区未另外保存 TS 业务实现。
- 原八包行／分支覆盖率门槛继续执行，[逐包数据](../../python/reports/coverage-comparison.json)。没有用测试数量替代原断言覆盖。
- 本阶段未新增业务偏差。上一阶段批准的七项修正及回归证据继续见 [独立偏差报告](../../python/reports/bug-deviations.md)；[文件兼容报告](../../python/reports/compatibility-storage.md) 和 [设备／MCP 兼容报告](../../python/reports/compatibility-devices-gateway.md) 保留。

## 样式和行为审查

使用 shadcn CLI **4.21.0** 取得官方 new-york-v4 组件与 neutral 主题，加入 components.json；[来源、哈希、许可与适配说明](../../docs/shadcn/README.md)。MIT 许可和来源说明也随安装包放入 `resources/third-party/shadcn`。

统一浅／深色颜色、边框、阴影、焦点和圆角，基础圆角 `0.625rem`。继续使用 Geist、Lucide、原共享目录、原 CSS 入口和 data-theme；未启用 Preflight。标题栏、设备／接线／编排／日志／设置、弹窗和 Agent 表现层使用同一组中性色；成功、警告、错误语义色保留。React Flow 控制按钮显式使用主题变量，避免 vendor 默认背景覆盖深色样式。

审查的 47 个 TSX 生产文件仅改变呈现属性、类名、预览色块和相关注释，没有更改事件处理或数据流。React Flow 103 条尺寸、定位、transform、命中和 stroke-width 声明与参考 revision 相同。共享组件保留原导出、props、ref、Button 默认 type、原生 Select 的空值／分组／事件对象、Checkbox 三态、Dialog Portal 及 Toast 数量与定时行为。

实际边框替代部分 ring 后，自动尺寸组件的边框／内容框可能相差每边 1px；这属于外观变更，不能把此次交付描述为所有组件逐像素尺寸不变。固定控件高度、面板布局和画布几何约束保留，真实指针／键盘回归通过。

原 renderer 全文件哈希作为历史证据保留；当前 [108 项保护记录](../../python/reports/stage-protected-files.json) 覆盖 Python 业务源码、renderer 纯 TS 逻辑、OpenCode main 文件及依赖／补丁。最终 [保护检查](final-protection.txt) 通过。

## 验证结果

| 检查 | 最终结果 | 证据 |
| --- | --- | --- |
| Python 独立门禁 | ruff check、format check、mypy strict、836 pytest 全通过；120 项映射及八包覆盖率门槛通过 | [完整日志](python-verify.txt) |
| TS pnpm verify | 类型、lint、217 tests、导入／依赖边界、knip、生产构建通过 | [完整日志](ts-verify.txt) |
| TS 覆盖率 | 217 tests；行／语句 50.07%，函数 61.78%，分支 70.76%；原 50／60／65／50 阈值不变 | [覆盖率日志](ts-coverage.txt) |
| 冻结 Python 真实进程 | 5/5，隔离 PATH 与 Python 环境变量 | [日志](frozen-smoke.txt) |
| 完整 Electron E2E | 使用冻结后端，27/27 | [完整日志](electron-frozen-e2e.txt) |
| 安装冒烟 | 中文及空格路径，真实只读 ACL，PATH 仅 System32，旧 safeStorage 密文重开，退出无后端残留 | [安装验收日志](windows-installed-acceptance.txt) |
| 生产产物核对 | 363 个输出文件与包内内容一致；七包缺席；shadcn notices 一致 | [核对日志](packaged-audit.txt)、[产物哈希](artifacts.json) |

217 个 TS 测试 = contracts 8 + desktop 209；836 是 Python 全套数量，冻结进程 5 项不另加。27 个 Electron 用例包含原 13 项、5 项新增交互和9项视觉矩阵。

新增回归覆盖 native Select 空值、键盘选择和 endpoint 排除，React Hook Form、Button submit/default/ref/Slot、三态 Checkbox、嵌套 Dialog 焦点恢复、Toast 容量／时长／复制／关闭、画布端口和节点拖动、侧栏键盘调整、表单 Enter 提交。真实 Assistant UI Composer 测试验证普通输入、Shift+Enter 换行、Enter 提交、运行中取消触发 AbortSignal 一次、恢复输入；没有替换被测 Composer 或取消按钮。

welcome-preview 的旧固定蓝色断言改为浏览器解析后的中性 token；其余原断言保留。测试在刷新前等待退出通知更新欢迎页，避免原有 dirty guard 的时序竞态。失败过程保存在 [早期 E2E 日志](electron-e2e-first-attempts.txt)，最终完整运行 27/27 通过。

## 视觉对照与范围

[打开前后截图画廊](visual/index.html)，[逐项比较及 PNG 哈希](visual/comparison.json)。浅色、深色、系统主题 × 960×600、1280×800、1600×1000；每组覆盖欢迎、设备、接线、编排、日志、三页设置、Agent 窄侧栏和未保存弹窗，共 **90 对截图**。控件类型、文案／标签、数量、禁用状态和原生选项逐项一致，窗口无额外横向溢出。已检查各组 contact sheet，并抽查全尺寸画布、表单、侧栏与弹窗。

`visual/before` 保留删除前安装包的90张原图。因原 Agent 图停在 lazy 加载态，额外从上述 Git revision 的原始 renderer／shared 文件重建视觉参照，保存在 `visual/reference`；这里只在临时目录重建 renderer，未复制 TS 业务后端。最终参照与改后截图均等待侧栏加载完毕，搭配同一当前平台层和冻结 Python 后端。[重建脚本](../../scripts/build-renderer-reference.mjs)、[源码 revision 记录](renderer-reference.json)。

截图中的 Agent 为未配置模型时的侧栏；运行态输入、取消、附件、权限和抽屉依赖组件交互测试及差异审查，没有进行真实外部模型会话的全状态截图验收。系统主题矩阵采用系统深色模拟，显式浅色和深色另行覆盖。

## 安装包

[TestForge-0.1.0-windows-x64.exe](../../dist/TestForge-0.1.0-windows-x64.exe)，**222,637,198 bytes**。

SHA-256：`37dc4e643b269f6c6d435c70d1ee9fd8ca4844e4f8d7bb9092a01632b90ec63e`。

Python 3.11.15、Electron 36.9.5、ICU 74.2；后端采用 PyInstaller onedir。目标机器无需 Python 或 uv。[Python 构建](python-build.txt)、[完整应用打包](package-win.txt)、[加入许可后的最终安装包](package-win-final.txt)。最后一次封装从已核验的 win-unpacked 生成，只补齐许可资源；安装冒烟使用的就是上面这个最终安装包。

独立干净 Windows 虚拟机和实际断网验收仍未执行。本机的隔离 PATH／清除 Python 环境变量／只读目录验证不能替代这两项外部环境验收。

自动审批审核拒绝了旧包依赖缓存目录的清理。业务源码和生成代码已删除；仅残留 Git 忽略的 node_modules 缓存及空目录，没有重试绕过该拒绝。
