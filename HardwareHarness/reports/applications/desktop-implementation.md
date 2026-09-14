# 应用搭建桌面端交付记录

- 编排测试入口、节点编辑器、节点任务契约和旧节点超时配置已退役；新 applications 类型契约与现有 Python stdio 转发、tRPC 和 preload 连通。旧字段不作为新 Run 类型的别名。
- CodeMirror 6 提供 Python / HTML / JavaScript / CSS / JSON 编辑、文件搜索、Ctrl+S、轻量诊断。文件操作使用磁盘 hash 校验，外部修改保留未保存内容；未保存草稿、标签、当前应用及树宽度可恢复。平台文件只读，依赖变更门禁由后端执行。
- 新日志页面显示实际步骤树、源代码快照、硬件事件、输出、异常、测量及附件下载。元数据按批读取完整历史，事件保留分页；删除与导出沿用现有操作入口。
- FastAPI 预览在独立 localhost iframe 中运行，不具备 desktop bridge 或 Node。实际 Electron 验证发现并修复跨站 Strict cookie 问题：后端改为独立应用 cookie，HttpOnly / Secure / SameSite=None / Partitioned，renderer CSP 仅补充 localhost frame-src。
- 安装资源新增 project-runtime-v1 → project-runtime，冻结后端与项目 CPython / uv / 离线 wheels 分开交付。
- 环境操作区新增明确的“联网安装依赖”。`initializeWorkspace(options?: { online?: boolean })` 保留默认无参调用，仅该入口发送 `online: true`；任何未保存编辑都会阻止安装，成功状态和安装错误在页面显示。

## 验证

- 完整 Electron E2E 28 / 28 通过；包括真实编辑器保存、离线新建环境、两个独立 Web 操作 Run、源快照、硬件 Python Run 重启读取/筛选/导出/删除、占用接线、Agent 和既有交互。
- 浅色/深色/系统主题及 960×600、1280×800、1600×1000 的截图与控件清单位于 visual/after；旧 shadcn 视觉报告保留。
- 最终 `pnpm verify` 通过：contracts 8 项、desktop 229 项，共 237 项；完整输出见 pnpm-verify.txt。覆盖输出见 ts-coverage.txt：行/语句 54.00%、分支 72.34%、函数 61.08%，原门槛未降低。
- 网络安装适配先新增回归测试，再实现。online-dependencies-red.txt / online-dependencies-green.txt 保存先红后绿证据；完整最终门禁包含默认准备、显式联网透传、严格 boolean 校验、脏编辑拒绝和安装失败显示。
- 退役文件哈希/参考 revision 见 retired-ts-node-files.json；逐项测试退役理由见 retired-ts-node-cases.json。
- 受保护 OpenCode main 源文件和依赖补丁 Git diff：无变更。

安装后的独立干净 Windows 与实际断网验证由总交付报告单独记录，本报告不把开发机通过视为其替代。

## 最后一次联调命令

在 `apps/desktop` 中运行以下 PowerShell 命令，使用构建好的项目运行时与离线 wheel 集合；桌面产物由前面的 `pnpm verify` 构建：

```powershell
$env:HARDWAREHARNESS_PROJECT_RUNTIME = 'E:/Project/hardwareHarness/HardwareHarness/python/dist/project-runtime-v1'
pnpm exec playwright test
```

这次验证包含最终 Python 项目切换生命周期、Agent 硬件互斥和环境安装入口。默认开发模式未设置运行时变量的一轮也完整通过 28 项，记录保留在 electron-e2e-development.txt；该模式首次准备依赖会联网，因此不作为离线验收证据。
