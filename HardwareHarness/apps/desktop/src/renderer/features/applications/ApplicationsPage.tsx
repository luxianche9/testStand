import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EditorTab } from "./workspace-model.js";
import type { RunStartInput } from "@hardwareharness/contracts/applications";
import { FilePlusIcon, FolderPlusIcon, PlayIcon, SaveIcon, SquareIcon, XIcon } from "lucide-react";
import { useProjectDocument } from "../../shared/queries.js";
import { errorMessage } from "../../shared/errors.js";
import { useResizableWidth } from "../../shared/resizable.js";
import { FeatureHeader, FeatureLayout } from "../../shared/FeatureLayout.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Input, Select, Textarea } from "../../shared/ui/index.js";
import { RunDetail } from "../run-logs/index.js";
import { CodeEditor } from "../../shared/CodeEditor.js";
import { mergeFile, updateTab, workspacePreferences } from "./workspace-model.js";

export function ApplicationsPage() {
  const project = useProjectDocument();
  return project.data ? <ApplicationWorkspace key={project.data.rootPath} rootPath={project.data.rootPath} /> : <p className="p-4 text-sm text-muted-foreground">请先打开工程。</p>;
}

function ApplicationWorkspace({ rootPath }: { rootPath: string }) {
  const api = window.hardwareharness.applications;
  const client = useQueryClient();
  const preferenceKey = `hardwareharness.applications.${rootPath}`;
  const initial = useMemo(() => workspacePreferences(localStorage.getItem(preferenceKey)), [preferenceKey]);
  const width = useResizableWidth({ defaultWidth: initial.width, min: 160, max: 440, direction: "right" });
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activePath, setActivePath] = useState(initial.activePath ?? "");
  const [appId, setAppId] = useState(initial.appId ?? "");
  const [restored, setRestored] = useState(false);
  const [panel, setPanel] = useState<"diagnostics" | "output" | "runs">("diagnostics");
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [line, setLine] = useState<number>();
  const [runId, setRunId] = useState<string>();
  const [dialog, setDialog] = useState<"file" | "directory" | "rename" | "delete" | "app" | "run" | "close">();
  const [target, setTarget] = useState("");
  const [dialogValue, setDialogValue] = useState("");
  const [inputs, setInputs] = useState("{}");
  const [hardwareIds, setHardwareIds] = useState("");
  const [launch, setLaunch] = useState<RunStartInput>();
  const [diagnosticDocument, setDiagnosticDocument] = useState<{ path: string; content: string }>();
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const active = tabs.find((tab) => tab.path === activePath);
  const activeReadOnly = Boolean(active?.readOnly || (active && managedFile(active.path)));
  const queryKey = useMemo(() => ["applications", rootPath], [rootPath]);
  const files = useQuery({ queryKey: [...queryKey, "files"], queryFn: () => api.listFiles(), refetchInterval: 2000 });
  const apps = useQuery({ queryKey: [...queryKey, "apps"], queryFn: () => api.listApps(), refetchInterval: 2000 });
  const runs = useQuery({ queryKey: [...queryKey, "runs"], queryFn: () => api.listRuns({ limit: 100 }), refetchInterval: 2000 });
  const selectedApp = apps.data?.find((app) => app.id === appId);
  const serviceLogs = useQuery({ queryKey: [...queryKey, "output", appId], queryFn: () => api.appLogs(appId), enabled: Boolean(appId), refetchInterval: 2000 });
  const matches = useQuery({ queryKey: [...queryKey, "search", search], queryFn: () => api.search(search), enabled: Boolean(search.trim()) });
  const diagnostics = useQuery({ queryKey: [...queryKey, "diagnostics", diagnosticDocument?.path, diagnosticDocument?.content], queryFn: () => api.diagnostics(diagnosticDocument!.path, diagnosticDocument!.content), enabled: Boolean(diagnosticDocument) });

  useEffect(() => {
    setDiagnosticDocument(undefined);
    if (!active?.path.endsWith(".py") || activeReadOnly) return;
    const timer = window.setTimeout(() => setDiagnosticDocument({ path: active.path, content: active.content }), 350);
    return () => window.clearTimeout(timer);
  }, [active?.path, active?.content, activeReadOnly]);

  const perform = useCallback(async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setNotice("");
    try { await operation(); await client.invalidateQueries({ queryKey }); }
    catch (error) { setNotice(errorMessage(error)); }
    finally { setBusy(false); }
  }, [client, queryKey]);

  const openFile = useCallback(async (path: string, atLine?: number): Promise<void> => {
    try {
      if (!tabsRef.current.some((tab) => tab.path === path)) {
        const file = await api.readFile(path);
        setTabs((current) => current.some((tab) => tab.path === path) ? current : [...current, { ...file, savedContent: file.content }]);
      }
      setActivePath(path); setLine(atLine); setPreview(false);
    } catch (error) { setNotice(errorMessage(error)); }
  }, [api]);

  useEffect(() => {
    let stopped = false;
    void Promise.all(initial.tabs.map((path) => api.readFile(path).catch(() => null))).then((result) => {
      if (stopped) return;
      const restoredTabs = result.flatMap((file, index) => {
        const draft = initial.drafts?.find((item) => item.path === initial.tabs[index]);
        return file ? [draft ? mergeFile(draft, file) : { ...file, savedContent: file.content }] : draft ? [draft] : [];
      });
      setTabs(restoredTabs);
      setActivePath((current) => restoredTabs.some((tab) => tab.path === current) ? current : restoredTabs[0]?.path ?? "");
      setRestored(true);
    });
    return () => { stopped = true; };
  }, [api, initial.drafts, initial.tabs]);

  useEffect(() => {
    if (!restored) return;
    try {
      localStorage.setItem(preferenceKey, JSON.stringify({ width: width.width, tabs: tabs.filter((tab) => !tab.readOnly).map((tab) => tab.path), drafts: tabs.filter((tab) => !tab.readOnly && tab.content !== tab.savedContent), activePath, appId }));
    } catch { setNotice("无法保存编辑器恢复信息，请保存文件后再离开工作区。"); }
  }, [activePath, appId, preferenceKey, restored, tabs, width.width]);

  useEffect(() => {
    let stopped = false;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      const results = await Promise.all(tabsRef.current.filter((tab) => !tab.readOnly).map(async (tab) => ({ path: tab.path, hash: tab.hash, file: await api.readFile(tab.path).catch(() => null) })));
      if (!stopped) setTabs((current) => current.map((tab) => {
        const found = results.find((result) => result.path === tab.path);
        return found?.file && found.hash === tab.hash ? mergeFile(tab, found.file) : tab;
      }));
      checking = false;
    };
    const timer = window.setInterval(() => { void check(); }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [api]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (tabsRef.current.some((tab) => tab.content !== tab.savedContent)) event.preventDefault(); };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);

  const save = async () => {
    if (!active || activeReadOnly || active.conflict) return;
    await perform(async () => {
      const saved = await api.writeFile({ path: active.path, content: active.content, expectedHash: active.hash });
      setTabs((current) => current.map((tab) => tab.path === saved.path ? { ...saved, savedContent: saved.content } : tab));
    });
  };
  const unsaved = tabs.some((tab) => tab.content !== tab.savedContent);
  const prepareEnvironment = (online = false) => {
    if (unsaved) { setNotice("请先保存所有文件再安装依赖。"); return; }
    void perform(async () => {
      const result = online ? await api.initializeWorkspace({ online: true }) : await api.initializeWorkspace();
      if (result.status !== "ready") throw new Error(result.error ?? "Python 环境尚未准备完成。");
      setNotice(online ? "联网安装依赖已完成。" : "Python 环境已准备完成。");
    });
  };
  const start = (input: RunStartInput) => {
    if (unsaved) { setNotice("请先保存所有文件再运行。"); return; }
    setLaunch(input); setInputs(JSON.stringify(input.inputs ?? {}, null, 2)); setHardwareIds((input.hardwareIds ?? []).join(", ")); setDialog("run");
  };
  const closeTab = (path: string) => {
    const tab = tabs.find((item) => item.path === path);
    if (tab && tab.content !== tab.savedContent) { setTarget(path); setDialog("close"); return; }
    setTabs((current) => current.filter((item) => item.path !== path));
    if (activePath === path) setActivePath(tabs.find((item) => item.path !== path)?.path ?? "");
  };
  const submitDialog = () => perform(async () => {
    if (dialog === "file" || dialog === "directory") { await api.createFile({ path: dialogValue, kind: dialog, content: "" }); if (dialog === "file") await openFile(dialogValue); }
    else if (dialog === "rename") {
      await api.renameFile({ path: target, target: dialogValue });
      const renamed = (path: string) => path === target || path.startsWith(`${target}/`) ? dialogValue + path.slice(target.length) : path;
      setTabs((current) => current.map((tab) => ({ ...tab, path: renamed(tab.path) })));
      setActivePath(renamed(activePath));
    }
    else if (dialog === "delete") { await api.deleteFile(target); setTabs((current) => current.filter((tab) => tab.path !== target && !tab.path.startsWith(`${target}/`))); }
    else if (dialog === "close") { setTabs((current) => current.filter((tab) => tab.path !== target)); if (activePath === target) setActivePath(""); }
    else if (dialog === "app") { const app = await api.createApp(dialogValue, dialogValue); setAppId(app.id); }
    else if (dialog === "run" && launch) {
      const parsed: unknown = JSON.parse(inputs);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("流程输入必须是 JSON 对象。");
      const run = await api.startRun({ ...launch, inputs: parsed as Record<string, unknown>, hardwareIds: hardwareIds.split(",").map((id) => id.trim()).filter(Boolean) });
      setRunId(run.runId); setPanel("runs");
    }
    setDialog(undefined);
  });
  const showSource = async (selectedRun: string, path: string, atLine: number) => {
    await perform(async () => {
      const file = await api.readRunSource(selectedRun, path);
      const id = `快照/${selectedRun}/${path}`;
      setTabs((current) => [...current.filter((tab) => tab.path !== id), { ...file, path: id, savedContent: file.content, readOnly: true }]);
      setActivePath(id); setLine(atLine); setPreview(false);
    });
  };

  return <FeatureLayout sidebar={{ position: "left", width, content: <div className="flex flex-col gap-2">
    <div className="flex items-center justify-between"><strong className="text-xs">.hardwareharness</strong><span className="flex"><Button size="icon-sm" variant="ghost" aria-label="新建文件" onClick={() => { setDialog("file"); setDialogValue("workflows/new.py"); }}><FilePlusIcon /></Button><Button size="icon-sm" variant="ghost" aria-label="新建目录" onClick={() => { setDialog("directory"); setDialogValue("workflows/new"); }}><FolderPlusIcon /></Button></span></div>
    <Input aria-label="搜索工作区" placeholder="搜索文件内容" value={search} onChange={(event) => setSearch(event.target.value)} />
    {search.trim() ? <div className="flex flex-col">{matches.data?.map((match, index) => <button key={index} className="truncate rounded px-1 py-1 text-left text-xs hover:bg-accent" onClick={() => void openFile(match.path, match.line)} title={match.text}>{match.path}:{match.line} {match.text}</button>)}</div> : <div role="tree" aria-label="工程文件树">{files.data?.filter((file) => ![...collapsed].some((path) => file.path.startsWith(`${path}/`))).map((file) => <div key={file.path} className="group flex items-center" style={{ paddingLeft: (file.path.split("/").length - 1) * 12 }}>
      <button role="treeitem" aria-expanded={file.kind === "directory" ? !collapsed.has(file.path) : undefined} aria-selected={activePath === file.path} className={`min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-xs hover:bg-accent ${activePath === file.path ? "bg-accent" : ""}`} title={file.path} onClick={() => { if (file.kind === "file") void openFile(file.path); else setCollapsed((current) => { const next = new Set(current); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next; }); }}>{file.kind === "directory" ? collapsed.has(file.path) ? "▸ " : "▾ " : ""}{file.name}</button>
      <button type="button" className="px-1 text-xs opacity-0 group-hover:opacity-100 focus:opacity-100" disabled={managedFile(file.path)} aria-label={`重命名 ${file.path}`} onClick={() => { setTarget(file.path); setDialogValue(file.path); setDialog("rename"); }}>⋯</button>
      <button type="button" className="px-1 text-xs opacity-0 group-hover:opacity-100 focus:opacity-100" disabled={managedFile(file.path)} aria-label={`删除 ${file.path}`} onClick={() => { setTarget(file.path); setDialog("delete"); }}>×</button>
    </div>)}</div>}
    {files.error && <p className="text-xs text-destructive">{errorMessage(files.error)}</p>}
  </div> }} header={<FeatureHeader title="应用搭建" actions={<>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => prepareEnvironment()}>准备 Python 环境</Button>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => prepareEnvironment(true)}>联网安装依赖</Button>
    <Button variant="outline" size="sm" onClick={() => { setDialog("app"); setDialogValue("my-app"); }}>新建应用</Button>
  </>}>
    <Select aria-label="选择应用" className="max-w-44" value={appId} onChange={(event) => setAppId(event.target.value)}><option value="">选择应用</option>{apps.data?.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}</Select>
    {selectedApp && <Button variant="outline" size="sm" disabled={busy || unsaved} onClick={() => void perform(async () => {
      if (selectedApp.status === "running") await api.stopApp(appId);
      else { await api.startApp(appId); setPreview(true); }
    })}>{selectedApp.status === "running" ? <SquareIcon /> : <PlayIcon />}{selectedApp.status === "running" ? "停止应用" : "启动应用"}</Button>}
  </FeatureHeader>}>
    {notice && <div role="status" className="flex items-start justify-between gap-2 border-b border-border bg-muted px-3 py-2 text-xs whitespace-pre-wrap">{notice}<button aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}
    <div className="flex flex-none flex-wrap items-center gap-1 border-b border-border p-1">
      <Button size="sm" variant={!preview ? "secondary" : "ghost"} onClick={() => setPreview(false)}>编辑器</Button><Button size="sm" variant={preview ? "secondary" : "ghost"} disabled={!selectedApp?.previewUrl} onClick={() => setPreview(true)}>Web 预览</Button>
      <span className="flex-1" /><Button size="sm" variant="ghost" disabled={!active || activeReadOnly || busy || Boolean(active.conflict)} onClick={() => void save()}><SaveIcon />保存</Button>
      <Button size="sm" variant="outline" disabled={!active?.path.endsWith(".py") || active.readOnly || busy} onClick={() => active && start({ entrypoint: active.path, name: active.path })}><PlayIcon />运行脚本</Button>
      {selectedApp?.actions.map((action) => <Button key={action.id} size="sm" variant="outline" disabled={busy} onClick={() => start({ applicationId: selectedApp.id, actionId: action.id, name: action.name, entrypoint: action.entrypoint, inputSchema: action.inputSchema, hardwareIds: action.hardwareIds })}>{action.name}</Button>)}
    </div>
    <section className="flex min-h-40 flex-1 flex-col overflow-hidden">
      {preview && selectedApp?.previewUrl ? <iframe title="应用 Web 预览" src={selectedApp.previewUrl} sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer" className="h-full w-full border-0 bg-white" /> : <>
        <div role="tablist" aria-label="打开的文件" className="flex flex-none overflow-auto border-b border-border bg-muted/30">{tabs.map((tab) => <div key={tab.path} className={`flex flex-none items-center border-r border-border ${activePath === tab.path ? "bg-background" : ""}`}><button role="tab" aria-selected={activePath === tab.path} className="px-3 py-2 text-xs" onClick={() => { setActivePath(tab.path); setLine(undefined); }}>{tab.readOnly ? "只读 · " : ""}{tab.path.split("/").at(-1)}{tab.content !== tab.savedContent ? " ●" : ""}</button><button aria-label={`关闭 ${tab.path}`} className="mr-1 rounded p-1 hover:bg-accent" onClick={() => closeTab(tab.path)}><XIcon className="size-3" /></button></div>)}</div>
        {active?.conflict && <div role="alert" className="flex items-center gap-2 border-b border-border bg-warning/10 p-2 text-xs">文件已在外部修改，当前未保存内容已保留。<Button size="sm" variant="outline" onClick={() => setTabs((current) => current.map((tab) => tab.path === active.path && tab.conflict ? { ...tab.conflict, savedContent: tab.conflict.content } : tab))}>载入磁盘版本</Button><Button size="sm" variant="outline" onClick={() => setTabs((current) => current.map((tab) => { if (tab.path !== active.path || !tab.conflict) return tab; return { path: tab.path, content: tab.content, savedContent: tab.conflict.content, hash: tab.conflict.hash }; }))}>保留编辑并合并</Button></div>}
        {active ? <div className="min-h-0 flex-1"><CodeEditor path={active.path} value={active.content} readOnly={activeReadOnly} line={line} onChange={(content) => setTabs((current) => current.map((tab) => tab.path === active.path ? updateTab(tab, content) : tab))} onSave={() => void save()} /></div> : <div className="grid flex-1 place-items-center p-5 text-xs text-muted-foreground">从左侧打开文件，或新建应用。</div>}
      </>}
    </section>
    <section className="flex h-[32%] min-h-28 flex-none flex-col border-t border-border">
      <div className="flex flex-none gap-1 bg-muted/30 p-1">{([ ["diagnostics", "诊断"], ["output", "应用输出"], ["runs", "运行记录"] ] as const).map(([id, label]) => <Button key={id} size="sm" variant={panel === id ? "secondary" : "ghost"} onClick={() => setPanel(id)}>{label}</Button>)}{panel === "runs" && <Select aria-label="选择运行" className="min-w-0 max-w-72" value={runId ?? ""} onChange={(event) => setRunId(event.target.value)}><option value="">选择运行</option>{runs.data?.map((run) => <option key={run.runId} value={run.runId}>{run.name} · {run.status}</option>)}</Select>}</div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {panel === "diagnostics" && <div className="flex flex-col gap-1 text-xs">{diagnostics.error ? <p className="text-destructive">{errorMessage(diagnostics.error)}</p> : diagnostics.data?.length ? diagnostics.data.map((item, index) => <button key={index} className="text-left hover:underline" onClick={() => void openFile(item.path, item.line)}>{item.path}:{item.line}:{item.column} [{item.code}] {item.message}</button>) : <span className="text-muted-foreground">{diagnostics.isFetching ? "正在检查…" : "没有诊断问题。"}</span>}</div>}
        {panel === "output" && <pre className="m-0 font-mono text-xs whitespace-pre-wrap">{serviceLogs.error ? errorMessage(serviceLogs.error) : serviceLogs.data?.map((item) => `${item.timestamp} [${item.stream}] ${item.text}`).join("\n") || "尚无应用服务输出。"}</pre>}
        {panel === "runs" && (runId ? <RunDetail runId={runId} onSource={(path, atLine) => void showSource(runId, path, atLine)} /> : <p className="text-xs text-muted-foreground">运行脚本或操作应用后，在此检查完整执行记录。</p>)}
      </div>
    </section>
    <Dialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(undefined); }}><DialogContent size="default" aria-label="工作区操作"><form onSubmit={(event) => { event.preventDefault(); void submitDialog(); }}><DialogHeader title={dialog === "run" ? "运行 Python 流程" : dialog === "app" ? "新建应用" : dialog === "delete" ? "删除文件" : dialog === "close" ? "放弃未保存修改" : dialog === "rename" ? "重命名" : "新建文件或目录"} onClose={() => setDialog(undefined)} /><DialogBody>
      {dialog === "run" ? <div className="flex flex-col gap-3"><label className="text-xs">输入 JSON<Textarea aria-label="流程输入 JSON" className="mt-1 min-h-32 font-mono" value={inputs} onChange={(event) => setInputs(event.target.value)} /></label><label className="text-xs">使用的主动硬件 ID（逗号分隔）<Input aria-label="流程硬件 ID" value={hardwareIds} onChange={(event) => setHardwareIds(event.target.value)} /></label><p className="text-xs text-muted-foreground">接线与占用须由用户或 Agent 提前完成，缺少占用将立即报错。</p></div> : dialog === "delete" || dialog === "close" ? <p className="text-sm">{dialog === "delete" ? `永久删除 ${target}？目录中的文件也将被删除。` : `放弃 ${target} 的未保存修改？`}</p> : <Input autoFocus required aria-label={dialog === "app" ? "应用名称" : "文件路径"} value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} />}
      {notice && <p role="alert" className="text-xs text-destructive">{notice}</p>}
    </DialogBody><DialogFooter><Button type="button" variant="outline" onClick={() => setDialog(undefined)}>取消</Button><Button type="submit" disabled={busy}>{busy ? "处理中…" : dialog === "run" ? "运行" : "确认"}</Button></DialogFooter></form></DialogContent></Dialog>
  </FeatureLayout>;
}

function managedFile(path: string): boolean { return ["project.json", "uv.lock"].includes(path.toLowerCase()); }
