"""Read-only OpenCode history export. Never executes recorded commands."""
import collections
import csv
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

sys.stdout.reconfigure(encoding="utf-8")
OUT = Path(__file__).resolve().parent
DB = Path(os.environ["APPDATA"]) / "HardwareHarness/opencode/data/opencode/opencode.db"
TZ = dt.timezone(dt.timedelta(hours=8))
con = sqlite3.connect(DB.as_uri() + "?mode=ro", uri=True)
con.row_factory = sqlite3.Row
con.execute("BEGIN")
sessions = [dict(r) for r in con.execute("SELECT id,parent_id,title,directory,time_created,time_updated FROM session ORDER BY time_created,id")]
messages = {r["id"]: dict(r) for r in con.execute("SELECT * FROM message ORDER BY time_created,id")}
parts = [dict(r) for r in con.execute("SELECT * FROM part ORDER BY time_created,id")]
con.close()

SECRET = re.compile(r"(?i)(?:[\"']?(?:token|api[_-]?key|password|secret|authorization|access_token|refresh_token)[\"']?\s*[:=]\s*[\"'])([^\"'\r\n]+)")
secret_values = set()
def discover(value):
    if isinstance(value, dict):
        for k, v in value.items():
            if re.fullmatch(r"(?i)(token|api[_-]?key|password|secret|authorization|access_token|refresh_token)", k) and isinstance(v, str) and len(v) >= 8:
                secret_values.add(v)
            discover(v)
    elif isinstance(value, list):
        for v in value:
            discover(v)
    elif isinstance(value, str):
        for match in SECRET.finditer(value.replace('\\"', '"')):
            if len(match[1]) >= 8:
                secret_values.add(match[1])

visible = []
overflow = {}
for p in parts:
    data = json.loads(p["data"])
    if data.get("type") == "reasoning":
        data = {"type": "reasoning", "omitted": True, "note": "私有推理正文未导出；仅保留事件位置。"}
    if data.get("type") == "file":
        data = {k: v for k, v in data.items() if k in ("type", "mime", "filename")}
        data["note"] = "二进制附件正文未嵌入导出。"
    p["data"] = data
    visible.append(p)
    discover(data)
    if data.get("type") == "tool":
        raw = str(data.get("state", {}).get("output", ""))
        for name in re.findall(r"tool-output[\\/](tool_[A-Za-z0-9_-]+)", raw):
            path = DB.parent / "tool-output" / name
            if path.is_file():
                content = path.read_text(encoding="utf-8", errors="replace")
                overflow[name] = content
                discover(content)

def clean(value):
    if isinstance(value, dict):
        return {k: ("[REDACTED]" if re.fullmatch(r"(?i)(token|api[_-]?key|password|secret|authorization|access_token|refresh_token)", k) and isinstance(v, str) else clean(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, str):
        for secret in sorted(secret_values, key=len, reverse=True):
            value = value.replace(secret, "[REDACTED]")
        value = SECRET.sub(lambda m: m[0][:-len(m[1])] + "[REDACTED]", value)
        value = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]{12,}", "Bearer [REDACTED]", value)
        return value
    return value

def stamp(ms):
    return dt.datetime.fromtimestamp(ms / 1000, TZ).isoformat(timespec="milliseconds")

def compact(v, n=220):
    text = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= n else text[:n] + "…"

def parsed_output(d):
    st = d.get("state", {})
    out = st.get("output", st.get("error", ""))
    try:
        return json.loads(out)
    except (ValueError, TypeError):
        for name in re.findall(r"tool-output[\\/](tool_[A-Za-z0-9_-]+)", str(out)):
            try:
                return json.loads(overflow[name])
            except (ValueError, KeyError):
                pass
        return out

def purpose(d):
    tool = d["tool"]
    inp = d.get("state", {}).get("input", {})
    target = next((inp[k] for k in ("description", "filePath", "path", "entrypoint", "runId", "pattern", "command") if k in inp), inp)
    verbs = {"read": "读取资料", "grep": "搜索实现/定义", "glob": "定位文件", "write": "创建或覆盖文件", "edit": "修改文件", "task": "委派子会话调研", "bash": "执行命令"}
    return verbs.get(tool, tool.removeprefix("hardwareharness_")) + "：" + compact(target)

def result_note(d):
    st = d.get("state", {})
    result = parsed_output(d)
    if st.get("status") == "error":
        return "调用失败；" + compact(st.get("error", ""), 400)
    if isinstance(result, dict):
        data = result.get("data", result)
        if isinstance(data, dict):
            run = data.get("run", data)
            if isinstance(run, dict) and "runId" in run:
                return "运行记录：" + compact({k: run[k] for k in ("runId", "status", "result", "error") if k in run}, 700)
            return "返回：" + compact(data, 350)
        if isinstance(data, list):
            terminal = [e for e in data if isinstance(e, dict) and e.get("type") in ("run.completed", "run.failed")]
            return "返回列表 %d 项%s" % (len(data), "；终态：" + compact(terminal, 600) if terminal else "；记录可查询不等于被查询对象已通过。")
    return "返回：" + compact(result, 350)

SPECIAL = {
 12: "路径查询失败且中文输出乱码；completed 只表示命令返回，不能当作目录存在。",
 30: "PowerShell 对 -Wl,--gc-sections 等未引用参数解析失败；T031 修正后 T032/T034 构建成功。",
 35: "固件路径被 firmwareRoots 拒绝；不是固件内容错误。后续 T047 改本机配置、T051 验证恢复。",
 44: "整份服务配置被打印，历史输出包含明文凭据。本次导出已脱敏；应只查询 firmwareRoots 等需要的字段。",
 45: "再次读取含凭据的服务配置，扩大上下文暴露面。本次导出已脱敏。",
 47: "变更服务级 firmwareRoots；是项目之外的配置副作用，应记录实际修改范围。",
 48: "服务重启超时；后续探针与离线校验成功只能证明服务可用，不能把超时本身写成成功。",
 53: "子会话找到的是测试替身机制；并无平台级真实 MCP 模拟开关。主流程测试覆盖边界应明确。",
 190: "首次实现主 HIL 流程；后续真机 T250 暴露 MCP 返回封装不匹配，说明实现对返回形状作了错误假设。",
 200: "FakeHardware 返回已解包数据；测试替换 module.call，绕过真实 MCP 封装层。不能验证真实 transport 契约。",
 201: "7 个模拟测试通过，有命令输出佐证；但 T250 的真机失败证明模拟通过不覆盖返回封装契约。",
 208: "ruff 与 7 项 pytest 通过。是代码与模拟逻辑验证，不能据此宣布硬件闭环通过。",
 250: "首个真机运行失败，报 SHA-256 changed。T254 添加解包后才推进到串口，支持返回层级问题；不应据错误文案认定固件真的变化。",
 254: "新增 _unwrap 处理 structuredContent/data，修复真实 MCP envelope 与 fake 返回不同的问题。仍需覆盖错误 envelope。",
 260: "运行在 PING/PONG 握手失败，看到空串。仅证明当前端到端握手失败，尚不能锁定线序或固件。",
 276: "卡端 pinout 是有效证据，但必须和开发板真实收发方向交叉核对；不能只按公母头或信号名字选交叉线。",
 277: "继续指定 2↔3、3↔2 交叉线；后续 T416/T423 的直通线实测成功，说明此建议在当时装置上没有奏效。",
 297: "回环 sent==received 且 ok=true，有效隔离了卡端收发路径；不能据此确认 DUT 连接的线序和电平。",
 306: "接 DUT 后仍无 PONG 且收到乱码；应优先核对物理收发方向、地线、模式和波形，再扩大固件变量。",
 316: "SRAM 读回运行状态与计数器，支持 MCU 主循环执行；不等于外部 RS232 引脚有正确波形。",
 320: "改写多波特率扫描，但可打印率用 Unicode isprintable，U+FFFD 替换字符也被算正常，不能作为 ASCII 协议匹配率。",
 325: "对乱码字节做重采样猜波特率，串口驱动已丢失原始波形和采样时序；其结果不能可靠重建 UART 电气时序。",
 347: "确定的寄存器语义错误：F407 USART_CR2 bit14 是 LINEN，bit8 是 LBCL，不是 TX/RX 反相位。此实验不能验证反相假设。",
 352: "烧录基于错误反相位定义的诊断固件，验证成功只证明写入，不代表实现了预期反相。",
 360: "加入静默分支提供对照实验，能观察噪声是否随发射源改变；应保持其他接线/模式条件不变。",
 367: "静默固件下全部扫描为 0 字节，为先前乱码与 DUT 发射相关提供支持；仍不能区分线序、电平、收发器与波特率。",
 373: "读取厂商 QIG 是正确取证步骤；应核对具体板卡型号与表格，不能另造“部分丝印相反”的结论。",
 377: "标准固件重新烧录并完成作业，后续串口监听应以该版本与波特率为基准。",
 383: "MCU 在运行；g_ms/seq 仅支持软件执行，不能证明外部串口链路在发送有效电气信号。",
 389: "period_before=period_after=1000，card_to_dut_ok=false；证明这次命令未生效，不能单凭此确定拨码是根因。",
 394: "历史查询当时数据库计数；它和今天快照不是同一时刻，数字差异本身不证明历史丢失。",
 399: "SRAM 计数继续增长；不能据此进一步断言拨码关闭了电平通道。",
 403: "恢复接线时复制了尚未验证通过的交叉方案；持久化恢复应区分最后记录与最后验证通过的配置。",
 415: "保存持久化项目记录；平台连接记录不等同于已测量确认物理连通。",
 416: "读取用户修改后的项目，串口记录改为 2↔2、3↔3、5↔5；这是后续实测解释的关键条件。",
 423: "115200 下有 TLM,1270 和 TLM,1271 可解析帧，直接证实当前 DUT→卡链路通过；多个条件改变，不能分离每个因素的因果贡献。",
 427: "再次启动完整 HIL，此调用只表示启动；最终业务是否通过要读 run.completed/result。",
 430: "分页读取实际运行事件，烧录/握手取证合理；应按 sequence 连续读取，区分过程成功与最终判定。",
 432: "该页包含最终测量/判定时应以 passed 为准；流程完成与模拟通路通过是不同状态。",
 435: "历史 occupancy request 的 confirmed 不保证当前有效租约；T436 仍被拦截，需统一有效占用查询。",
 436: "占用被拒后 T437 重新申请，是正确恢复；前一句“占用仍有效”没有有效租约证据。",
 443: "第二次完整 HIL 仍 passed=false，gain=-0.0106，max_error_mv=2913；数字回读正常，模拟闭环未完成。",
 453: "实际 inputs 只扫描 AI0–AI8，9 个通道；此前宣称将扫 AI0–AI15 的计划未完整执行。",
 456: "responding_channels={}、wiring_ok=false；限定为本次 9 通道条件下未观察到响应，不能排除未扫描通道、AO/AI配置、共地、接触或器件损伤。",
 457: "只抽取工作流关键字不足以证明异常安全收尾；当前实现无 finally，reference_error_mv 也未参与 passed。"
}
for n in range(212, 217):
    SPECIAL[n] = "端口引用格式不匹配；后续读取定义后使用重复限定 ID 才成功。反映平台硬件 ID/port ID 组合契约不直观，非物理接线失败。"
for n in (287, 328, 335):
    SPECIAL[n] = "有效占用缺失而被拒；历史 confirmed 请求不是持续有效租约，应查询实时占用状态后执行。"

def analysis(d, number):
    if number in SPECIAL:
        return SPECIAL[number]
    tool = d["tool"]
    st = d.get("state", {})
    out = str(st.get("output", ""))
    if st.get("status") == "error":
        return "先解决返回的错误条件，再判断该操作能否继续；不把失败调用计入完成成果。"
    if "truncated" in out.lower():
        return "正文发生截断；本导出尝试保存 tool-output 原文。必须查看展开内容才能判断完整结果。"
    if tool in ("write", "edit"):
        return "工具报告写入成功；代码正确性须结合后续构建/测试/运行，历史参数保留了具体写入内容。"
    if tool in ("read", "glob", "grep"):
        return "只读取证；返回结果支持资料/实现定位，不直接证明硬件运行结论。"
    if tool == "bash":
        command = str(st.get("input", {}).get("command", ""))
        if "Start-Sleep" in command:
            return "固定时长等待不提供状态证据；应结合随后查询。长等待可由事件等待或有界轮询替代。"
        if re.search(r"Traceback|ParserError|error:|NOT FOUND|E501|F401", out):
            return "输出含错误或缺失信号；completed 仅为工具返回，应核查退出码及后续修复。"
        return "需以命令正文、退出状态和输出共同判断；工具状态 completed 本身不代表子命令成功。"
    if "start_python_run" in tool or "start_application" in tool:
        return "启动请求成功只表示任务已提交；最终状态和业务判定必须由后续查询确认。"
    if "request_wiring" in tool or "request_hardware_occupancy" in tool:
        return "请求已创建不等于人工确认或实际连通；须核对后续状态和有效期。"
    if "flash" in tool or "read_sram" in tool:
        return "硬件异步作业需要等待终态；成功提交不能替代 verified/实际读回证据。"
    return "按返回的对象状态解释结果；工具完成、对象完成、业务通过应分别判断。"

def text_analysis(text, role):
    if role == "user":
        return "用户目标、指令或现场反馈；物理状态陈述作为用户报告保留，不等同于测量确认。"
    if "烧录成功说明固件在跑" in text:
        return "推断错误：写入/回读校验只能证明 Flash 内容一致，不能证明时钟、波特率、程序执行与串口电气路径正确。"
    if "反相不是根因" in text:
        return "排除依据无效：T347 写入的不是反相位，因此实验根本未实现所声称的自变量，不能排除反相。"
    if "真正的问题在直通线" in text or "必须交叉" in text:
        return "交叉线结论过度确定；后续在直通记录下 T423 收到正确遥测。应核对实际收发方向和连接器编号，保留跳帽、模式与接触因素。"
    if "1u << 14" in text:
        return "涉及寄存器语义，参见 T347 的独立核对。"
    if "100%" in text or "必然有效" in text or "唯一的卡点" in text:
        return "确定性超出可见证据；需保留替代原因，参见报告中的因果归因问题。"
    if "25" in text and "-15V" in text:
        return "针脚电压定义与用户实际接了哪个设备/哪根线是两件事；“接到25”不足以确定实际负压误接。"
    if "反相" in text:
        return "反相诊断的代码实现有确定错误，见 T347；不能根据该试验成败判定反相假设。"
    if "g_ms" in text and ("一直在发" in text or "持续发送" in text or "电平通道" in text):
        return "由计数器增长推断外部串口波形或拨码根因，证据不足；只可确认软件在执行。"
    if "先模拟" in text or "7/7" in text:
        return "模拟测试确有 7 项通过记录；覆盖业务逻辑，不覆盖真实 MCP 封装及物理接线，见 T200/T250。"
    if "succeeded" in text or "passed" in text or "全链路" in text:
        return "需区分运行结束与业务判定；最后两个完整 HIL 仍 passed=false，不能宣布整个闭环完成。"
    if "gpt6" in text or "deepseek-flash" in text:
        return "本快照 330 条 assistant 消息均标记 openai/deepseek-flash；只证明记录的模型别名，不证明代理服务底层实际模型或平台不能切换。"
    return "公开进度/结论陈述；用相邻工具调用核对支持程度，不将陈述本身视为成功证据。"

(OUT / "tool-output").mkdir(exist_ok=True)
for name, content in overflow.items():
    (OUT / "tool-output" / (name + ".txt")).write_text(clean(content), encoding="utf-8")

counts = collections.Counter(p["data"].get("type") for p in visible)
tool_counts = collections.Counter()
transcript = ["HH 内嵌 OpenCode 可见历史（UTF-8，凭据脱敏，私有推理正文省略）", "数据库：" + str(DB), "排序：part.time_created，part.id。交错子任务按时间排列，不表示同步完成。", ""]
entries = ["# 逐事件分析", "", "T 编号覆盖全部工具调用；E 编号覆盖全部 text/tool/file 事件。对应输入和返回全文见 transcript.txt、visible-history.jsonl。", "", "下面是每个事件的记录摘要与证据边界；重点问题经过人工核对，其余按操作类型标注。不是对每行源代码的穷尽代码审查，也不披露私有思维链。", ""]
jsonlines = []
index = []
event_n = tool_n = 0
line_refs = {}
for p in visible:
    d = clean(p["data"])
    m = messages[p["message_id"]]
    md = json.loads(m["data"])
    record = {"part_id": p["id"], "message_id": p["message_id"], "session_id": p["session_id"], "time": stamp(p["time_created"]), "role": md["role"], "data": d}
    typ = d.get("type")
    if typ not in ("tool", "text", "file"):
        jsonlines.append(record)
        continue
    event_n += 1
    eid = f"E{event_n:04}"
    record["event_id"] = eid
    tid = ""
    if typ == "tool":
        tool_n += 1
        tid = f"T{tool_n:03}"
        record["tool_id"] = tid
        tool_counts[(d["tool"], d["state"]["status"])] += 1
    header = f"{eid} {tid} {record['time']} {p['session_id']} {md['role']} {typ}"
    line = len(transcript) + 1
    line_refs[tid or eid] = line
    transcript += [header, "message_id=" + p["message_id"] + " part_id=" + p["id"]]
    entries += [f"## {eid} {tid} · {record['time']} · {md['role']}", "", f"会话 `{p['session_id']}`；[原记录]({(OUT / 'transcript.txt').as_posix()}:{line})。", ""]
    if typ == "text":
        txt = d.get("text", "")
        transcript += txt.splitlines()
        entries += ["原文摘要：" + compact(txt, 450), "", "分析：" + text_analysis(txt, md["role"]), ""]
    elif typ == "file":
        transcript += [json.dumps(d, ensure_ascii=False)]
        entries += ["附件元数据：" + compact(d), "", "分析：二进制附件未转录；不能仅据附件存在判断其内容。", ""]
    else:
        st = d["state"]
        transcript += ["工具：" + d["tool"], "状态：" + st["status"], "输入："]
        transcript += json.dumps(st.get("input", {}), ensure_ascii=False, indent=2).splitlines()
        transcript += ["输出/错误："] + str(st.get("output", st.get("error", ""))).splitlines()
        for name in re.findall(r"tool-output[\\/](tool_[A-Za-z0-9_-]+)", str(st.get("output", ""))):
            if name in overflow:
                transcript += ["本地展开文件：" + str(OUT / "tool-output" / (name + ".txt"))]
        note = analysis(d, tool_n)
        entries += ["操作：" + purpose(d), "", "结果：" + clean(result_note(d)), "", "分析：" + note, ""]
        index.append({"tool_id": tid, "event_id": eid, "session_id": p["session_id"], "time": record["time"], "tool": d["tool"], "status": st["status"], "purpose": purpose(d), "analysis": note, "transcript_line": line, "part_id": p["id"], "message_id": p["message_id"]})
    transcript += [""]
    jsonlines.append(record)

(OUT / "transcript.txt").write_text("\n".join(transcript), encoding="utf-8")
(OUT / "event-analysis.md").write_text("\n".join(entries), encoding="utf-8")
with (OUT / "visible-history.jsonl").open("w", encoding="utf-8") as f:
    for r in jsonlines:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
with (OUT / "tool-index.csv").open("w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(index[0]))
    w.writeheader()
    w.writerows(index)
manifest = {"source": str(DB), "exported_at": dt.datetime.now(TZ).isoformat(), "snapshot": "SQLite read transaction; mode=ro", "sessions": sessions, "message_count": len(messages), "parts": dict(counts), "visible_events": event_n, "tools": tool_n, "tool_statuses": dict(collections.Counter(x['status'] for x in index)), "tool_counts": [{"tool": k[0], "status": k[1], "count": v} for k, v in tool_counts.items()], "overflow_files": len(overflow), "redacted": "Credentials scrubbed; private reasoning body and binary attachment body omitted", "models": dict(collections.Counter(json.loads(m['data']).get('modelID', 'user') for m in messages.values())), "line_refs": line_refs}
(OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
message_meta = []
for m in messages.values():
    data = json.loads(m["data"])
    selected = {k: data[k] for k in ("role", "parentID", "modelID", "providerID", "model", "agent", "time", "finish", "tokens", "cost") if k in data}
    message_meta.append({"id": m["id"], "session_id": m["session_id"], "data": clean(selected)})
(OUT / "messages.json").write_text(json.dumps(message_meta, ensure_ascii=False, indent=2), encoding="utf-8")
# Verify export completeness and redaction without printing credentials.
assert tool_n == sum(v for (k, s), v in tool_counts.items()) == counts["tool"]
assert len(jsonlines) == len(parts)
assert all(r["data"] == {"type": "reasoning", "omitted": True, "note": "私有推理正文未导出；仅保留事件位置。"} for r in jsonlines if r["data"].get("type") == "reasoning")
hashes = {}
for p in OUT.rglob("*"):
    if p.is_file() and p.name != "export_audit.py":
        content = p.read_bytes()
        assert not any(s.encode("utf-8") in content for s in secret_values if len(s) >= 12 and s != "[REDACTED]")
        hashes[str(p.relative_to(OUT))] = hashlib.sha256(content).hexdigest()
(OUT / "sha256.json").write_text(json.dumps(hashes, indent=2), encoding="utf-8")
print(json.dumps({"output": str(OUT), "sessions": len(sessions), "messages": len(messages), "parts": dict(counts), "visible_events": event_n, "tools": tool_n, "overflow_files": len(overflow), "validation": "counts and known-secret removal passed"}, ensure_ascii=False))
