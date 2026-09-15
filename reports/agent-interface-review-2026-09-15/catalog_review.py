"""Static inventory and proposed documentation. Does not import or execute hardware servers."""
import ast
import collections
import csv
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent

# Proposed descriptions describe current behavior unless explicitly marked as a change.
B = {
"get_project": ("P0", "读取当前打开工程的根目录、持久化文档、接线连接与未保存状态。用于确定工作区和已有连接；无工程时按返回状态先打开或初始化工程。画布记录不证明物理导通。", "补 runtime/sdk/contract 版本、环境状态和可直接复用的端点引用；列表默认摘要，详细连接可按需取。"),
"initialize_project": ("P1", "在指定的现有绝对目录创建并打开新 HH 工程。已有工程、未保存改动或活跃执行会拒绝。不会自动配置接线或完成 Python 依赖初始化；成功后检查工程状态。", "rootPath 标注本机绝对目录、存在性、已有工程冲突；给出后续 initialize_workspace。"),
"open_project": ("P1", "按本机绝对目录打开已有 HH 工程。未保存改动和活跃执行会阻止切换。成功后重新读取工程和会话状态；不要假设上个工程的待办仍有效。", "错误带 dirty/activeRun 等阻塞项；明确切换后会话接线待办生命周期。"),
"save_project": ("P0", "通过项目服务保存当前工程及画布文档。检查返回的 dirty 状态；保存记录不执行物理接线。Python 源文件的写入状态与工程文档的保存状态分别核对。", "精确列出保存对象、revision、dirtyBefore/After；不要把物理连接当成保存效果。"),
"list_remote_computers": ("P1", "列出已登记计算机及非敏感连接标识，用 computerId 查询状态。此列表说明配置存在，不保证主机在线；不返回认证凭据。", "补摘要过滤/分页与 computerId 来源示例。"),
"get_remote_computer_status": ("P1", "查询一个已登记计算机的 SSH 可达性及托管 MCP 服务状态。computerId 从计算机列表复制；SSH 在线不等于硬件可操作。", "分别返回 host/ssh/service/device 状态和 observedAt，说明探测超时。"),
"list_mcp_servers": ("P0", "列出已登记 MCP 服务、所绑定硬件及连接状态。用于选择 serverId 与识别公开工具来源；服务登记或连接成功不代表目标电路通过测试。", "补 toolCatalogRevision、可用工具/契约引用、能力摘要、offline原因；避免重复全量硬件资料。"),
"get_remote_mcp_service": ("P1", "刷新一个已登记 MCP 服务的进程和连接状态。用于核对启动、停止或重启结果；unknown 表示尚无法确认，不应解释为停止或成功。", "区分进程运行、握手完成、硬件ready；生命周期返回 operationId 后统一等待。"),
"start_remote_mcp_service": ("P1", "按已配置生命周期启动服务，可能初始化设备和驱动。serverId 从服务列表复制。超时不代表未启动；先查询状态再决定下一步。", "发布副作用、依赖、运行冲突、异步 operationId 和幂等语义。"),
"stop_remote_mcp_service": ("P1", "按服务的正常关闭流程停止 MCP 服务，可能应用设备安全状态并断开硬件。操作前核对活跃运行；成功与安全收尾结果分别检查。", "返回每设备 cleanup 结果，明确失败/未知状态；不把进程退出当作物理安全。"),
"restart_remote_mcp_service": ("P1", "按已配置的正常关闭与启动流程重启 MCP 服务。可能改变设备会话和输出配置；超时后先查询状态，避免重复重启。", "拆分 stop/start/reconnect 阶段结果；不要要求读 server.json 或进程实现。"),
"read_remote_mcp_logs": ("P1", "读取一个 MCP 服务最近的日志，lines 默认200、范围1–2000。用于服务故障诊断；truncated 为真时当前响应不完整。", "持久化及返回前脱敏；加 cursor/severity/time 范围；明确日志能看到什么。"),
"list_managed_hardware": ("P0", "列出平台管理的主动硬件及当前健康状态。用于选择 hardwareId；健康状态和执行资源可用状态应分别检查，不能由登记成功推断设备可用。", "合并公开 availability/busyReason/observedAt；当前不能只靠 raw health。"),
"list_hardware_catalog": ("P0", "列出本地登记的主动/被动硬件定义、端口和引脚。用于查接线资料，不会测量设备。调用接线工具时复用规范端点引用，不自行拼接 ID。", "增加摘要/搜索/分页、endpointRef；避免一次返回全部pinout。当前引用需由返回契约补齐。"),
"get_hardware_definition": ("P0", "按 hardwareId 读取一份硬件定义及端口/引脚资料。区分厂商资料、人工录入和实时观测；本工具不验证实物版本或当前跳帽状态。", "分节、版本/资料页码/坐标/勘误、唯一endpointRef；暴露单位、方向及参考地。"),
"save_hardware_definition": ("P1", "创建或更新一份本地硬件定义。影响目录和画布引用，不操作实物。必须按硬件定义 schema 提交；修改已有端口/引脚 ID 前检查关联接线。", "完整硬件 schema 生成字段说明；加 expectedRevision、预览diff和引用影响，不额外发明人工审批。"),
"remove_hardware_definition": ("P1", "删除指定硬件的本地定义及关联图片。不会卸载驱动或移除实物；删除前核对工程引用，检查返回结果。", "声明破坏性、引用冲突、删除范围和是否可恢复。"),
"set_hardware_image": ("P2", "为硬件外观或指定端口设置 PNG/JPEG/WebP 图片。imageBase64 是图片编码，portId 使用目录中的原值；此动作只修改资料图片。", "补字节/像素限制、fileName用途、数据URL规则；推荐artifactId，避免大base64进上下文。"),
"remove_hardware_image": ("P2", "移除指定硬件外观图或端口图；省略 portId 时作用于硬件外观图。不会删除硬件定义或改变物理接线。", "验证与实现一致的幂等语义；返回删除对象及剩余资料引用。"),
"add_managed_hardware_to_canvas": ("P1", "幂等地将已登记主动硬件加入当前工程画布，已存在时返回 added=false。会改变工程未保存状态；不创建物理接线或测量结果。", "明确拒绝被动硬件、added/node/dirty 输出；给出保存后续动作。"),
"request_wiring_task": ("P0", "创建人工 connect/disconnect 接线待办，返回 wiringTaskId 和状态；本调用不移动任何线缆。端点和 pinId 必须来自目录的规范引用。确认后更新项目连接记录，待办本身属于应用会话。", "修复 ID 拼接；给规范endpoint对象、线序预览、同端口回环支持或明确unsupported、冲突existingTaskId、持久化提示。"),
"cancel_wiring_task": ("P1", "取消尚未完成的接线待办。取消待办不会撤销已经插好的线，也不会自动断开已确认连接；检查返回的当前状态。", "说明pending/in_progress与terminal差别；需断开用新的disconnect任务。"),
"get_wiring_task": ("P1", "读取本应用会话中的一个接线待办。返回状态、到期时间和结果；confirmed 是人工确认记录，不是电气测量。重启后任务可能不存在。", "unknown_task结构化错误附 session/recovery；支持revision等待而不是shell sleep。"),
"list_wiring_tasks": ("P1", "按状态列出当前会话最近的接线待办，limit默认100、最大500。列表为空不代表工程没有已保存连接；已有连接应查询 get_project。", "补分页、sessionId和连接/待办分离说明。"),
"list_workspace_files": ("P0", "列出当前工程 .hardwareharness/scripts 下的 Python 程序；隐藏平台目录和非.py文件。返回的相对路径可用于读取、更新和启动程序。", "声明不覆盖docs/tests；另提供reference入口和脚本create入口。"),
"read_workspace_file": ("P0", "读取 scripts/ 下一个 UTF-8 Python 文件，返回 content 与 hash。path 使用斜杠相对 .hardwareharness，最大4MiB；更新时把 hash 作为 expectedHash。", "允许line range/分页；文档走独立read_reference，避免放宽整个受管理目录。"),
"write_workspace_file": ("P0", "按 expectedHash 更新一个已存在的 scripts/*.py 文件。先读取得到当前 hash；冲突时重新读取并合并。本工具当前不能创建缺失文件。", "新增create_workspace_file（独占创建）或显式create模式；不使用空hash假装创建。"),
"initialize_workspace": ("P0", "准备当前工程共享 Python/uv 环境。默认online=false从随包离线wheels安装；online=true才允许依赖索引安装。操作前保存更改并停止Python运行，完成后检查环境状态。", "返回interpreterPath、依赖版本、文档入口、能力和离线状态；公开测试/创建程序路线。"),
"validate_python_file": ("P0", "对 scripts/*.py 进行 Python 语法与 Ruff 静态检查，返回诊断。本工具不执行脚本、不验证硬件行为，也不等于模拟测试通过。", "输出诊断schema（path,line,column,code,severity）、检查版本与完整性；分别提供无硬件测试能力。"),
"start_python_run": ("P0", "启动一个已保存的 scripts/*.py，入口 main(inputs)，支持同步或异步，输入/返回为JSON。hardwareIds列出将用的主动设备。返回runId仅表示创建/启动；之后读取Run终态和业务结果。", "写清snapshot、输入schema、资源冲突、sdkToolName、无自动重放；增加显式测试模式需实现后发布。"),
"cancel_python_run": ("P0", "请求取消运行：先协作退出，最多约10秒后可能终止进程树。取消不撤销远端物理动作，清理可能失败；查询最终状态和未知结果，不能自动重放。", "返回cancelRequested/terminal/cleanup/outcomeKnown；消除与读日志无关的模板提示。"),
"get_python_run": ("P0", "读取指定Run的状态、业务返回值/错误及部分事件。succeeded仅代表程序正常结束；若业务返回passed=false仍未通过。hasMore为真时继续分页读取事件。", "默认compact不附巨量events；明确终态、verdict、artifact引用、分页cursor。"),
"list_python_runs": ("P1", "查询当前工程运行记录，支持search和limit。历史记录存在不代表设备当前状态；选定runId后读取具体结果。", "默认1000/最大10000过大；改摘要分页，按status/verdict/time筛选。"),
"get_python_run_events": ("P0", "按Run事件sequence分页读取。after表示已读的最后序号（不含），从0开始；按最后sequence继续，核对eventCount直至终态。事件包含步骤、硬件调用、测量、错误和附件登记。", "补nextCursor/hasMore/terminal、eventType过滤、输出预算和溢出artifact；不要指示模型直接找磁盘日志。"),
}

R = {
"get_server_info": ("P0", "读取本服务版本、设备绑定和初始化状态，不执行实验动作。服务就绪不等于物理链路已验证。", "补 capabilitiesRef、schemaRevision、实际/模拟模式、脱敏有效配置；FireDAP发布firmware导入路径策略。"),
"list_hardware": ("P1", "列出本服务管理的设备；当前约定一个服务恰好管理一个主动设备。此列表用于身份发现，不代表全部通道健康。", "给输出模型和one-server-one-device约束；可以在默认发现层与平台list去重，但保留兼容端点。"),
"get_hardware_info": ("P0", "读取该设备身份与健康摘要，不执行信号激励。网关会注入绑定的hardwareId；应用使用平台返回的标识。", "补型号/固件/驱动/通道范围/模式可观测性、capabilitiesRef；区分静态声明与当前测量。"),
"get_pinout": ("P0", "读取设备连接器、针号、模式相关信号与方向；这是接线参考，不探测当前线缆或开关位置。", "按connector筛选和分页；加入endpointRef、插合面/焊接面视角、厂商版本和来源页码；方向不根据公母头推断。"),
"cp118u_configure_port": ("P0", "配置CP-118U逻辑端口的波特率、帧格式和流控。channel从1开始并对应P1…P8，非Windows COM号。此配置不改变板卡实体RS232/422/485拨码；结果中的mode是帧格式编码。", "channel实际范围、baud枚举、data_bits/parity/stop_bits/flow允许值与默认值；返回com映射、electricalMode=unknown/manual，不猜模式。"),
"cp118u_write_text": ("P0", "将text按UTF-8发送到channel端口，不自动添加CR/LF。bytes表示驱动接受的发送字节数，不证明对端收到或执行。clear_rx=true会丢弃已收数据。", "UTF8字节数与字符数、部分写入、超时unknown、副作用和重复命令风险；例子显式\\r\\n。"),
"cp118u_write_hex": ("P1", "把hex_data解析为原始字节后发送，允许空白分隔，不自动追加帧尾。返回写入字节数，不能替代对端确认；clear_rx=true先丢弃接收缓存。", "偶数hex格式/上限、channel范围、部分写入；标明非幂等，不自动重放。"),
"cp118u_read_rx": ("P0", "读取自最近清空以来的累计RX缓存，并在timeout_ms窗口内继续采集。重复读取可能返回相同数据；max_bytes限制返回前缀。hex为原始字节，text为UTF8替换解码，乱码不等于ASCII帧。", "明确非消费式累计语义、timeout_ms=0空读成功与>0空读错误；建议统一idle成功、加cursor/totalBytes/truncated/decodeErrorCount。"),
"cp118u_clear_rx": ("P1", "清空指定端口的软件累计RX缓存及硬件接收FIFO，已收证据会丢失；此操作不改变线缆和电气模式。", "channel范围、丢弃数据量可返回；不要把它称为只读查询。"),
"cp118u_flush": ("P1", "清空指定端口rx、tx或both缓冲区；默认both，可能丢失接收数据或待发送数据。它不是等待发送完成的drain操作。", "what枚举；区分flush/clear_rx范围，建议显式指定what避免默认误清tx。"),
"cp118u_get_line_status": ("P0", "查询该逻辑端口驱动报告的波特率、帧格式、流控和线路状态。channel不是COM号；本结果不能证明实体拨码模式或DUT收发方向。", "返回bitmask解释/单位/观测时间；字段重命名区分frameMode与electricalMode。"),
"pci1710l_configure_ai": ("P0", "配置PCI-1710L的一个AI通道后再采样。channel为0基；signal_type=0单端、1差分；value_range是量程枚举，不是电压数值。", "运行时公开支持枚举、单端/差分有效通道及成对接线；兼容1=±10V等映射，优先新增语义enum。"),
"pci1710l_read_voltage": ("P0", "读取已配置AI通道的实际采样电压，单位V。返回值依赖输入模式、量程和参考地；读数接近零不能单独说明线缆未接。", "result.volts、sampling/config metadata、overrange、timestamp；通道范围依据模式；与AO shadow区分。"),
"pci1710l_read_bit": ("P1", "读取0基通道0–15的DI或DO位，kind=DI/DO。DO寄存器回读不等同于对端观察到输出电平。", "kind枚举和boolean结果；标明DI测量/DO寄存器证据类型。"),
"pci1710l_set_level": ("P1", "将0基DO通道0–15设置为指定逻辑电平，会改变真实数字输出。调用成功不证明DUT响应。", "level布尔、端口电气限制/参考地由capabilities提供；返回commanded而非杜撰measured。"),
"pci1710l_safe_state": ("P0", "按设备配置的safe_do_mask设置数字输出并检查可用回读；这会改变真实输出。具体安全值由配置决定，不承诺无条件全零。", "公开safeMask、作用通道、partialFailure、readback证据范围；失败不得报告已安全。"),
"pci1762_set_relay": ("P1", "设置0基RELAY0–15，closed=true使线圈吸合。输出回读只能验证控制状态，不证明外部触点连通或负载动作。", "布尔语义、通道范围、NO/NC/COM参考；负载额定由硬件资料给出。"),
"pci1762_set_bank": ("P1", "按16位mask设置继电器，bit0对应RELAY0，0≤mask≤65535。底层按8位端口写入，不能保证16路整体原子切换。", "bit顺序/批量影响范围、部分失败状态；不向用户承诺整卡同步动作。"),
"pci1762_read_bit": ("P1", "读取0基通道0–15的DI或继电器控制回读；kind=DI/RELAY，DO为当前兼容别名。回读不测量触点电阻。", "kind枚举与兼容别名、采样证据类型、时间。"),
"pci1762_safe_state": ("P0", "释放16路继电器并检查控制回读，会改变真实继电器状态。操作失败或部分失败时不能认为负载已经隔离。", "每通道结果、失败通道、控制回读与物理触点验证分开。"),
"pci6208v_set_voltage": ("P0", "设置PCI-6208V的0基AO通道0–7，volts单位V，卡范围±10V；超范围拒绝，不钳位后写入。必须同时满足接收设备的更窄额定范围。返回设定值不代表外部实测电压。", "finite number、min/max、负载保护范围、appliedCommand/evidence=driver_ack；底层旧docstring的clamped需纠正。"),
"pci6208v_read_last": ("P0", "读取当前打开会话最后成功写入的AO设定值，这是软件影子值，板卡没有该工具可用的ADC回读。尚未写入则报错；不能用它证明线端有对应电压。", "字段lastCommandedVolts/evidence=software_shadow；状态失效时间和no_value错误；文档首句强调。"),
"pci6208v_safe_state": ("P0", "将全部8路AO设置为已配置safe_volts；该值不一定是0V。真实输出会改变，某些通道可能失败；结果不是独立电压测量。", "公开safeVolts、覆盖所有通道/影响范围、partial failures；模型必须先知道安全设定实际值。"),
"firedap_list_probes": ("P1", "枚举CMSIS-DAP USB探针，不连接或复位MCU。枚举到探针不代表目标板供电、SWD连通或MCU运行。", "返回探针身份和观察时间；序列号不等于MCU UID。"),
"firedap_get_board_reference": ("P0", "读取随服务提供的被动板卡连接器、跳帽、共享网络和资料来源，不查询实物。资料型号/版本必须与目标板一致。", "应迁移为独立hardware reference能力；section/query/分页、页码证据与artifact引用，避免70KB整块返回。"),
"firedap_inspect_firmware": ("P0", "离线检查服务主机可访问的BIN/HEX/ELF/AXF文件，验证地址并计算SHA-256，不访问MCU。path必须在该服务允许的固件目录内；裸BIN需要适用的base_address。", "返回acceptedFormats/pathNamespace/rootPolicy；新增import artifact到受管目录，不要求代理改server.json。"),
"firedap_flash": ("P0", "提交扇区烧录及逐字节回读校验，使用inspect所得expected_sha256。返回jobId后等待终态；reset_after默认true。仅成功作业且verified=true证明写入校验，不证明固件行为。", "删除过时occupancy文案，改当前availability/conflict；发布范围、未知结果查询路线、reset副作用和受管artifact。"),
"firedap_verify": ("P0", "提交固件内容与目标Flash的回读比较，不编程。使用inspect所得摘要并等待job终态；验证内容相符不代表程序运行正确。", "移除旧occupancy要求；明确attach影响、异步schema、verified字段和错误。"),
"firedap_target_info": ("P1", "提交attach-only目标身份读取，不主动reset或写Flash。等待job终态；DBGMCU识别范围可能仅到芯片组，不能证明封装或板卡修订版。", "jobId/result.target/deviceId/identityLimit schema；目标身份与MCU执行状态区分。"),
"firedap_reset": ("P1", "提交目标MCU复位，会中断当前固件行为。返回jobId，查询终态；超时不代表没有复位，不应自动重复。", "reset类型、完成定义与恢复观察、非重复调用约束。"),
"firedap_read_sram": ("P0", "提交不中断/不复位目标的主SRAM读取。address和length需4字节对齐，length≤4096；返回jobId后等待结果。多字采样不是自动原子快照，地址含义须有对应固件符号依据。", "明确区域/对齐/最大值/字节序；计数增长不能直接证明外部信号。"),
"firedap_wait_job": ("P0", "等待已有job，timeout_seconds范围1–60。超时只停止等待，可能返回running，不取消烧录；只有state=succeeded后才能使用成功结果。", "公布running/succeeded/failed完整union、返回revision、elapsed；轮询操作可继续，原动作不重放。"),
"firedap_get_job": ("P0", "查询已有job状态及结果，不重新提交硬件动作。只在succeeded时使用结果；flash/verify需检查verified，其他作业按对应结果判定。", "未知job与服务重启导致记录丢失要区分；管理查询不应被无关执行锁阻断。"),
}

records=[]
gateway=ROOT/'HardwareHarness/python/src/hardwareharness_backend/mcp_gateway'
for fn in ('project_tools.json','builtin_tools.json'):
    p=gateway/fn
    raw=p.read_text(encoding='utf-8')
    for item in json.loads(raw):
        t=item['tool']; name=t['name']; priority,desc,gaps=B[name]
        start=raw[:raw.index('"name": "'+name+'"')].count('\n')+1
        records.append(dict(name=name,group='platform',source=p.relative_to(ROOT).as_posix(),line=start,current_description=t.get('description',''),input_schema=t['inputSchema'],current_output_schema=t.get('outputSchema'),current_annotations=t.get('annotations'),priority=priority,proposed_description=desc,required_changes=gaps,capability=item['capability']))

hidden=[]
for folder,prefix,sid in [('cp118u_i','cp118u_','CP118U_I_MCP'),('pci1710l','pci1710l_','PCI1710L_MCP'),('pci6208v','pci6208v_','PCI6208V_MCP'),('pci1762','pci1762_','PCI1762_MCP'),('firedap','firedap_','FIREDAP_MCP')]:
    p=next((ROOT/'mcp_servers/servers'/folder/'app/src').glob('*/server.py'))
    tree=ast.parse(p.read_text(encoding='utf-8'))
    for n in sorted(ast.walk(tree),key=lambda n:getattr(n,'lineno',0)):
        if not isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) or not any(isinstance(d,ast.Call) and isinstance(d.func,ast.Attribute) and d.func.attr=='tool' for d in n.decorator_list):continue
        if n.name=='hardwareharness_prepare_shutdown':
            hidden.append(dict(server=sid,name=n.name,source=p.relative_to(ROOT).as_posix(),line=n.lineno,note='只由服务生命周期调用；不向Agent/业务SDK发布；必须公开关闭可能应用安全值及partial failure。'))
            continue
        if not (n.name.startswith(prefix) or n.name in ('get_server_info','list_hardware','get_hardware_info','get_pinout')):continue
        priority,desc,gaps=R[n.name]
        args=[]
        for a in n.args.args:
            if a.arg=='hardwareId':continue
            args.append(dict(name=a.arg,type=ast.unparse(a.annotation) if a.annotation else 'unknown'))
        records.append(dict(name=sid+'__'+n.name,group=sid,source=p.relative_to(ROOT).as_posix(),line=n.lineno,current_description=ast.get_docstring(n) or '',input_signature=ast.unparse(n.args),public_parameters=args,return_annotation=ast.unparse(n.returns) if n.returns else '',priority=priority,proposed_description=desc,required_changes=gaps,public_metadata_gap='网关目录未保留上游outputSchema/annotations/支持的元数据；必须按公开返回形状转换后发布，而非盲目透传。'))

assert len(records)==83
assert len({r['name'] for r in records})==83
assert len(hidden)==5
stats=dict(public_tools=len(records),builtin=34,remote=49,remote_missing_description=sum(not r['current_description'] for r in records if r['group']!='platform'),builtin_output_schemas=sum(bool(r.get('current_output_schema')) for r in records if r['group']=='platform'),builtin_parameters=sum(len(r.get('input_schema',{}).get('properties',{})) for r in records),builtin_parameter_descriptions=sum('description'in p for r in records for p in r.get('input_schema',{}).get('properties',{}).values()),internal=len(hidden),groups=dict(collections.Counter(r['group'] for r in records)),source_mode='Static registrations for five bundled server configurations; not a live tools/list snapshot')
(OUT/'inventory.json').write_text(json.dumps(dict(stats=stats,tools=records,internal=hidden),ensure_ascii=False,indent=2),encoding='utf-8')

md=['# 全量 MCP 工具说明与契约优化清单','','范围：当前34个内置工具 + 五类服务49个公开工具，共83项；另列5个仅内部生命周期工具。按实际serverId条件分支选取，未将四份适配器文件里的重复分支重复计数。不是已连接发行版的实时目录。','','每项“建议说明”是可直接用于后续改稿的文本，描述当前可验证语义；“必须补齐”可能要求改接口或实现，尚未发布。当前签名只是服务函数签名，最终模型收到的JSON Schema应由发行版 tools/list 快照验收。','']
for i,r in enumerate(records,1):
    code=ROOT/r['source']
    md += [f"## {i:02}. {r['name']} · {r['priority']}",'',f"来源：[代码]({code.as_posix()}:{r['line']})；分组：{r['group']}。",'',"当前说明："+(r['current_description'] or '（空：公开注册函数无docstring/description）'),'',"建议说明："+r['proposed_description'],'',"必须补齐："+r['required_changes'],'']
    if r['group']=='platform':
        props=r['input_schema'].get('properties',{})
        md += ['参数字段：'+(', '.join(props) or '无')+'。所有字段应包含业务含义、ID来源、单位/边界；非适用项明确N/A。','','输出：目前无outputSchema；新增成功、失败和处理中结果结构及实例。','']
    else:
        md += ['当前函数签名：`'+r['input_signature']+'`。hardwareId由网关注入，不出现在聚合工具公开参数里；SDK仍需单独传hardware_id。','',r['public_metadata_gap'],'']
md += ['## 内部生命周期工具','','这些工具在原始服务注册，但由网关过滤，不计入83个Agent公开工具。','']
for r in hidden:md += [f"- `{r['server']}__{r['name']}`：{r['note']}"]
(OUT/'all-tools-review.md').write_text('\n'.join(md),encoding='utf-8')
with (OUT/'all-tools-review.csv').open('w',encoding='utf-8-sig',newline='') as f:
    keys=['name','group','priority','current_description','proposed_description','required_changes','source','line'];w=csv.DictWriter(f,fieldnames=keys,extrasaction='ignore');w.writeheader();w.writerows(records)
print(json.dumps(stats,ensure_ascii=False))
