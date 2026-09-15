"""Build the human-reviewed findings, linking stable transcript event IDs."""
import json
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
M = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
def ref(key):
    return f"[{key}]({(ROOT / 'transcript.txt').as_posix()}:{M['line_refs'][key]})"
def artifact(name):
    return f"[{name}]({(ROOT / name).as_posix()})"
def source(path, line):
    return f"[{Path(path).name}:{line}]({Path(path).as_posix()}:{line})"

workflow = "E:/Project/hardwareHarness/examples/stm32_example1/.hardwareharness/workflows/hil_hardware_test.py"
sniff = "E:/Project/hardwareHarness/examples/stm32_example1/.hardwareharness/workflows/serial_sniff.py"
tests = "E:/Project/hardwareHarness/examples/stm32_example1/.hardwareharness/tests/test_hil_hardware_test.py"
firmware = "E:/Project/hardwareHarness/examples/stm32_example1/firmware/src/main.c"
cmsis = "E:/Project/learnSTM32/bad_apple/vendor/Libraries/CMSIS/Device/ST/STM32F4xx/Include/stm32f407xx.h"

report = f"""# HH 内嵌 OpenCode 会话审计

读取日期：2026-09-15。历史主会话时间：2026-09-14 15:54–17:38，UTC+8。

结论：这段工作确实交付了固件、HIL 工作流和诊断程序，并获得串口、烧录、数字回读的真实通过证据；完整模拟闭环仍未通过。最值得纠正的是错误的 UART 寄存器操作、模拟测试对真实 MCP 契约的漏检，以及多次把有限观测直接写成确定根因。

本报告分析可见对话、代码改动、工具参数和工具结果。私有推理正文未导出、未逐行解释；对应 211 个 reasoning 事件仅保留位置。所有“操作目的”均根据公开操作和上下文概括，不是对内部思维链的复原。

## 数据范围与阅读入口

数据库：`{M['source']}`。

使用 SQLite `mode=ro` 和只读事务取得一致快照；没有重放历史命令、操作设备、修改固件或修改原始历史。

| 项目 | 数量/说明 |
|---|---|
| 会话 | 6；其中 3 个有消息、3 个为空 |
| 消息 | 355；25 条 user、330 条 assistant |
| 主会话 | `Greeting`，318 条消息 |
| 子会话 | `Summarize board reference file (@explore subagent)` 8 条；`Find mock hardware mechanism (@explore subagent)` 29 条 |
| 工具调用 | 457；446 个 completed、11 个 error |
| 可见文本 part | 158 |
| 可见事件索引 | 616：158 段文本、457 次工具、1 个附件元数据 |
| 全部 part | 1484，含 step-start/step-finish 与省略正文的 reasoning 占位 |
| 模型元数据 | 330 条 assistant 均为 providerID=openai、modelID=deepseek-flash |
| 截断输出展开 | 8 份本地 tool-output 文件 |

模型元数据只说明应用记录的别名，不能证明兼容接口后面实际运行什么模型，也不能证明平台不支持切换。历史中“平台没有可切换 gpt6”的说法超出了这些证据。

- {artifact('event-analysis.md')}：616 个事件依次排列，每次调用均有操作、结果和分析。重点问题经过具体核对；一般读取/搜索操作标明证据用途与局限。
- {artifact('transcript.txt')}：保留可见正文及工具输入/输出全文，可按本报告链接跳转到行号。日志内自带的源代码行号与该文件物理行号不同。
- {artifact('tool-index.csv')}：457 行工具索引，便于筛选错误、工具类型与会话。
- {artifact('visible-history.jsonl')}：逐 part 的机器可读导出；保留 session/message/part ID 和毫秒时间。
- {artifact('messages.json')}、{artifact('manifest.json')}：消息元数据、父子关系、模型别名和统计。

导出按 `part.time_created, part.id` 排序。长工具的结果在原调用条目内，因此它与子会话交错的位置不等于结束顺序。正文凭据已按字段/已识别值脱敏；二进制附件仅导出元数据；8 份溢出文件取自导出时的磁盘内容，并非与数据库同一事务快照。

## 过程复盘

| 阶段 | 对应事件 | 可见操作与结果 | 评价 |
|---|---|---|---|
| 环境调研 | T001–T023 | 查询项目、硬件、SDK、工具链，子会话整理板卡资料 | 先取证合理；大 JSON、字符编码引入反复读取 |
| 固件实现 | T024–T051 | 生成寄存器驱动固件、修构建脚本、调整 firmwareRoots、离线校验 | 固件可构建有证据；服务重启曾超时，校验通过不等于软件在运行 |
| 运行契约调研 | T052–T189 | 搜索模拟机制、SDK、MCP 服务和应用运行方式 | 有用但范围偏大；模拟模式实际落到测试替身 |
| 工作流与应用 | T190–T211 | 编写 HIL、Web 应用与 fake 测试，7 项测试通过 | 应用逻辑形成；真实封装层漏检 |
| 接线与首次真机 | T212–T260 | 5 次端口引用失败、读取定义、申请接线/占用、运行 | 暴露端口契约与占用状态理解问题；先修封装错误，再遇串口空读 |
| 串口隔离 | T261–T306 | 看原理图、指定交叉线、卡端回环成功、再次连 DUT 失败 | 回环是好实验；据此“100% 锁定线序”不成立 |
| 扩大诊断 | T307–T389 | 扫波特率、读 SRAM、9600/所谓反相/静默固件、查拨码、命令探测 | 产生有用数据，但反相位错误、评分失真、改变多个因素 |
| 状态恢复 | T390–T415 | 定位会话库、重建接线与画布、保存工程 | 恢复有记录；复制了尚未验证成功的交叉方案 |
| 串口打通 | T416–T432 | 读取直通记录、收到 TLM、完整 HIL 出 PONG/ID/DI | 串口和数字部分有真实通过证据，模拟不通过 |
| 模拟诊断 | T433–T457 | 再申请租约、重跑、扫描 AI0–AI8 | 最后仍 passed=false；模拟故障尚无唯一根因 |

## 逐项核实的问题

### 1. [P1] “UART 反相”实验写错寄存器位

{ref('T347')} 加入的两行是 `USART3->CR2 |= (1u << 14)` 与 `USART3->CR2 |= (1u << 8)`，分别放在 `UART_INVERT_TX` 和 `UART_INVERT_RX` 条件下。

STM32F407 的 CMSIS 头文件明确把 bit14 定义为 `LINEN`，bit8 定义为 `LBCL`，分别是 LIN 模式使能和最后一位时钟脉冲。它们不是 TX/RX 反相位。证据：{source(cmsis,12573)}、{source(cmsis,12592)}；当前残留实现：{source(firmware,251)}。

因此，{ref('T352')} 烧录成功不代表实现了反相；后续“反相不是根因”的排除没有成立的实验前提。影响限于启用这些宏的诊断配置，不能据此认定普通固件也总在错误模式下运行。

修正方向：撤销错误选项，按 F407 实际外设能力设计诊断；固定接线与模式后，用波形或独立测量验证信号极性。

### 2. [P1] 异常路径没有保证执行输出归零

主流程先设置 AO，然后请求 ADC 并读取 AI；若串口响应缺失或硬件调用抛错，可以在归零前退出。`safe_state` 调用位于正常路径，没有 `try/finally`。证据：{source(workflow,239)}、{source(workflow,260)}、{source(workflow,272)}。

历史最后的流程说明声称“每轮结束 AO 归 0V”，实际只能证明正常走到这些语句时会执行。平台是否另有租约释放安全动作不在本段代码中，本报告没有据此断言设备必然保持危险输出。

修正方向：由工作流保证 finally 清理；各设备的清理应分别尝试，避免第一个失败阻止第二个。针对“AO 已设置后串口/AI 失败”验证收尾。

### 3. [P2] 模拟测试绕过真实 MCP 返回封装

{ref('T201')}、{ref('T208')} 确认 7 项测试通过。首次真机 {ref('T250')} 却报 `Firmware SHA-256 changed between inspect and flash`。随后 {ref('T254')} 增加 `_unwrap` 处理 `structuredContent/data`，流程才推进到串口握手。

FakeHardware 直接返回数据，测试替换的是 `module.call`，实际绕过新加的 `call → _raw_call → _unwrap` 路径。证据：{source(tests,199)}。当前测试、工作流文件与第二次完整 HIL 的历史 source 快照字节一致，因而不是只凭今天代码反推。

这支持“返回层级不匹配导致错误报成 SHA 变化”，并不支持固件文件真的在两次调用间改变。模拟测试不是无效，但覆盖范围被夸大。

修正方向：使用真实 envelope 形状的契约样本，覆盖成功、错误及缺失字段；保留业务 fake 测试。

### 4. [P2] 串口“可打印率”不能代表 ASCII 协议有效率

{source(sniff,38)} 使用 Unicode `isprintable()`。Python 中 `�`（U+FFFD）和 `ÿ` 都返回 True。{ref('T423')} 中 2400 波特率样本是 `�`，57600 波特率也有大量乱码，但可打印率仍为 1。

`best` 又按 `(printable, bytes)` 排序，可能偏好长度更大的乱码。虽然本次 115200 确实得到完整 TLM 帧，工具整体评分仍不可靠。

修正方向：以原始字节的 ASCII 范围、CRLF 完整帧、TLM/PONG/ID 语法与字段校验来评分；替换字符计入解码失败。全部 0 字节时不得强行返回一个“最佳波特率”。

### 5. [P2] 对线序、拨码、SRAM 的因果解释多次过头

- {ref('E0333')} 写“烧录成功说明固件在跑、时钟正常、波特率计算无误”。烧录回读验证仅证明存储内容，不证明这些运行属性。
- {ref('E0354')} 断言“真正的问题在直通线”；{ref('E0387')} 在卡端回环通过后又说“100% 锁定在线序”。{ref('T297')} 的回环仅验证卡端局部通路，没有测到 DUT、收发器、跳帽及外部连线。
- 后续把拨码变化后空读解释为电平通道被关闭，也缺少电气测量。{ref('T383')}、{ref('T399')} 的 `g_ms/seq` 支持软件执行，不能证明外部 RS232 上有有效波形。
- {ref('T389')} 的 TLM 500 未生效证明该次命令失败，不能单独区分线序、模式、接触、收发器或解析问题。

最终 {ref('T416')} 记录直通，{ref('T423')} 在 115200 下读到可解析 TLM。这使此前“必须交叉”的确定结论不再能直接用于当前装置。由于用户还调整过拨码、跳帽、接触，不能反过来宣布只改直通就解释全部历史故障。

修正方向：固定固件、波特率、拨码与跳帽，记录每次只改变哪一项；把“观测”“候选解释”“排除条件”分别写清楚。

### 6. [P2] AI 扫描范围和根因结论不匹配

公开计划说扫描 AI0–AI15，实际 {ref('T453')} 的输入为 `0,1,2,3,4,5,6,7,8`，只扫描 9 个通道。{ref('T456')} 得到 `responding_channels={{}}`。

可证明的是：本次配置和接线条件下，所扫 9 个通道未观察到期望的 3V 响应。不能排除 AI9–AI15，也不能仅靠这些结果区分 AO 未输出、通道配置、测量参考、接线、接触、共地或器件问题。

用户说“我连到25了”时，未在该句话里明确是哪张卡、哪根线以及当前实际线端。指出某卡 25 脚定义为 -15V 可以是核对线索，但历史随后把“接到 -15V 而非地”写成故障判断，证据不足。

修正方向：先明确两端设备/连接器/针号；独立测量 AO 相对 A.GND 的电压，再检查 AI 配置和连通性。物理状态未核实时避免扩大输出试验。

### 7. [P2] 独立 AI 参考通道未进入最终通过判定

{source(workflow,279)} 计算并记录 `reference_error_mv`，但最终 `passed` 仅组合 UART 误差、单调性、数字回读和增益，没有包含参考通道误差：{source(workflow,288)}。

若 UART 数据正确而 AI 基准链路坏掉，代码仍可能返回 passed=true。此次实际运行的 UART 误差已经足够导致失败，因此这不是本次失败的原因，而是验收完整性的缺口。

修正方向：如果演示声称验证 AO→AI 基准闭环，应该给该项独立阈值并纳入最终验收；否则明确标成仅供诊断的观测项。

### 8. [P2] confirmed 请求与当前有效租约混用

{ref('T287')}、{ref('T328')}、{ref('T335')}、{ref('T436')} 均为 `occupancy_required`。尤其 {ref('T435')} 查询申请记录后宣称占用仍有效，下一次调用又被拒。

这是历史申请状态与有效租约状态不一致，或至少查询结果不够支持操作；不能因为人工曾确认就认为长期有效。后续重新申请是正确恢复方式。

平台改进方向：让工具返回当前租约状态、剩余期限、失效原因；代理先检查执行所需的全部设备，避免反复失败再申请。

### 9. [P2] 端口引用契约导致连续 5 次失败

{ref('T212')}–{ref('T216')} 使用直观的 `DUT_1.CON1` 等引用被拒；读取硬件定义与实现后，使用 `DUT_1.DUT_1.CON1` 等重复限定形式才成功。

这首先是引用解析和工具说明的一致性问题，不能向用户解释为物理硬件不存在或接线未完成。已有硬件发现能力，代理也应在首次失败后用返回的规范 ID 生成请求。

平台改进方向：明确 hardwareId、portId、pinId 是局部还是全限定；返回可直接复用的端点引用，提供结构化错误及候选 ID。

### 10. [P2] 历史工具输出包含服务凭据

{ref('T044')} 与 {ref('T045')} 读取整份 `server.json`，把其中服务凭据带入工具输出。实际任务只需要确认 firmwareRoots 与相关服务配置，没必要打印认证字段。

本次导出已脱敏，不在报告复述凭据。后续工具/日志宜按字段过滤，并在持久化前统一处理凭据；本次未变更任何凭据。

### 11. [P3] 调研、等待和状态汇报的效率问题

在主 HIL 文件首次写入之前，已经发生 189 次工具调用，其中有子会话并行操作；这不等于 189 次串行耗时，但说明取证范围很大。多次全目录搜索、大 JSON 展开和编码故障增加噪声。

存在固定 60 秒、150 秒的 shell 等待（T237/T239）。它们本身不提供状态证据，也容易降低用户可见进度的连续性。可改成有界事件等待或紧凑状态查询。

后半段多次出现“唯一卡点”“只要接好就必然有效”“接好就 passed=true”等承诺，缺少实测依据。应给出已通过的具体项目、尚未通过的验收项和下一次能区分哪些候选原因。

## 最终成果与未完成部分

| 证据 | 实际结论 |
|---|---|
| T034/T051 | 固件已构建并可离线校验 |
| T201/T208 | 7 项模拟测试通过，真实 MCP 契约覆盖不足 |
| T297 | CP-118U 卡端回环通过 |
| T423 | 当前直通记录条件下，115200 收到 TLM 帧 |
| T430–T432 | 完整 HIL 的烧录、PONG、ID 和数字回读有成功事件 |
| T443 | 第二次完整 HIL：passed=false，gain=-0.0106，max_error_mv=2913，DI 为 1→1、0→0 |
| T456 | AO→AI 诊断：wiring_ok=false，扫描通道无期望响应 |

第一次完整执行到判定的运行是 `run_116fa5f4c15e490686103be017ed12f7`；后续重跑为 `run_3fcd20b961d5497983ffdea9cff52802`。两次都不能算完整 HIL 验收通过。

`status=succeeded` 表示 Python 任务正常返回；`result.passed=false` 表示业务测试未通过。平台和汇报都应该让这两种状态容易区分。历史没有完全隐瞒失败，确实展示了 passed=false；问题在于同时使用了“核心已经打通”等容易弱化未完成目标的措辞。

## 后续修正次序（本次仅分析，未执行）

1. 纠正 UART 反相位定义、异常收尾、协议评分三个实现问题。
2. 补 MCP envelope 契约验证，并明确 reference_error 是否属于验收条件。
3. 使用固定固件与记录完整的物理配置，把串口成功条件保存为已验证基线。
4. 独立确认 AO 实际输出，再排查 AO→AI、AO→PA0；避免在未确认信号来源时继续根据噪声猜根因。
5. 完整 HIL 的各项验收通过后，才将演示标为完成。

## 校验与局限

导出计数与数据库快照一致，457 个工具编号连续且唯一；616 个可见事件均有索引；已检查已识别凭据未出现在导出文件。私有推理正文和二进制附件正文明确省略。对照文件中的既有乱码保持原状，不能修复已经损坏的历史编码。

当前 `hil_hardware_test.py`、`serial_sniff.py`、`test_hil_hardware_test.py` 与 `run_3fcd20b961d5497983ffdea9cff52802/source` 中对应文件字节一致。UART 宏写入有历史 edit 参数佐证，寄存器语义另由本地 STM32F407 CMSIS 头文件交叉核对。

没有重新运行真实硬件，也没有对所有源代码行做完整审查；逐事件表中一般性的读取/写入说明不应被误解为已验证其全部内容正确。具体缺陷和状态结论以上述证据为边界。
"""
(ROOT / "analysis-report.md").write_text(report, encoding="utf-8")

# Preserve the minimal code evidence without changing the source project.
evidence = ROOT / "code-evidence"
evidence.mkdir(exist_ok=True)
for name, path in [("hil_hardware_test.py.txt",workflow),("serial_sniff.py.txt",sniff),("test_hil_hardware_test.py.txt",tests),("main.c.txt",firmware)]:
    (evidence/name).write_bytes(Path(path).read_bytes())
lines = Path(cmsis).read_text(encoding="utf-8").splitlines()
(evidence/"stm32f407-cr2-excerpt.txt").write_text("Source: " + cmsis + "\n" + "\n".join(f"{i+1}: {lines[i]}" for i in range(12568,12596)), encoding="utf-8")
hashes = {p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in ROOT.rglob('*') if p.is_file() and p.name != 'sha256.json'}
(ROOT/'sha256.json').write_text(json.dumps(hashes,indent=2),encoding='utf-8')
print(str(ROOT / "analysis-report.md"))
