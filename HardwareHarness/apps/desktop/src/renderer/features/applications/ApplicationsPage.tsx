import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RunRecord } from "@hardwareharness/contracts/applications";
import { FilePlusIcon, PlayIcon, SquareIcon } from "lucide-react";
import { CodeEditor } from "../../shared/CodeEditor.js";
import { errorMessage } from "../../shared/errors.js";
import { FeatureLayout } from "../../shared/FeatureLayout.js";
import { useProjectDocument } from "../../shared/queries.js";
import { useResizableWidth } from "../../shared/resizable.js";
import { Button } from "../../shared/ui/button.js";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../../shared/ui/dialog.js";
import { Input } from "../../shared/ui/input.js";
import { ScriptTerminal } from "./ScriptTerminal.js";
import { mergeFile, updateTab, workspacePreferences, type EditorTab } from "./workspace-model.js";

export function ApplicationsPage() {
  const project = useProjectDocument();
  return project.data ? <PythonWorkspace key={project.data.rootPath} rootPath={project.data.rootPath} />
    : <p className="p-4 text-sm text-muted-foreground">请先打开工程。</p>;
}

function PythonWorkspace({ rootPath }: { rootPath: string }) {
  const api = window.hardwareharness.applications;
  const preferenceKey = `hardwareharness.applications.${rootPath}`;
  const initial = useMemo(() => workspacePreferences(localStorage.getItem(preferenceKey)), [preferenceKey]);
  const width = useResizableWidth({ storageKey: `${preferenceKey}.width`, defaultWidth: initial.width, min: 160, max: 440, direction: "right" });
  const [documents, setDocuments] = useState<EditorTab[]>([]);
  const [activePath, setActivePath] = useState(initial.activePath ?? "");
  const [restored, setRestored] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(initial.terminalOpen ?? false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [newScriptOpen, setNewScriptOpen] = useState(false);
  const [scriptName, setScriptName] = useState("");
  const [createError, setCreateError] = useState("");
  const [runId, setRunId] = useState(initial.runId);
  const [run, setRun] = useState<RunRecord>();
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const operationPending = useRef(false);
  const selectionRequest = useRef(0);
  const active = documents.find((document) => document.path === activePath);
  const running = run?.status === "running" || run?.status === "cancelling";
  const files = useQuery({ queryKey: ["applications", rootPath, "files"], queryFn: () => api.listFiles(), refetchInterval: 2000 });
  const scripts = files.data?.filter((file) => file.kind === "file" && file.path.endsWith(".py")) ?? [];

  const reportError = useCallback((error: unknown) => {
    setNotice(errorMessage(error));
    setTerminalOpen(true);
  }, []);

  useEffect(() => { if (files.error) reportError(files.error); }, [files.error, reportError]);

  useEffect(() => {
    let stopped = false;
    void Promise.all(initial.tabs.map((path) => api.readFile(path).catch(() => null))).then((result) => {
      if (stopped) return;
      const restoredDocuments = result.flatMap((file, index) => {
        const draft = initial.drafts?.find((item) => item.path === initial.tabs[index]);
        return file ? [draft ? mergeFile(draft, file) : { ...file, savedContent: file.content }] : draft ? [draft] : [];
      });
      setDocuments(restoredDocuments);
      setActivePath((current) => restoredDocuments.some((document) => document.path === current) ? current : restoredDocuments[0]?.path ?? "");
      setRestored(true);
    });
    return () => { stopped = true; };
  }, [api, initial.drafts, initial.tabs]);

  useEffect(() => {
    if (!restored) return;
    try {
      localStorage.setItem(preferenceKey, JSON.stringify({
        width: width.width,
        tabs: documents.map((document) => document.path),
        drafts: documents.filter((document) => document.content !== document.savedContent),
        activePath, terminalOpen, runId
      }));
    } catch { reportError("无法保存编辑恢复信息，请按 Ctrl+S 保存脚本。"); }
  }, [activePath, documents, preferenceKey, reportError, restored, runId, terminalOpen, width.width]);

  useEffect(() => {
    let stopped = false;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      const results = await Promise.all(documentsRef.current.map(async (document) => ({
        path: document.path, hash: document.hash, file: await api.readFile(document.path).catch(() => null)
      })));
      if (!stopped) setDocuments((current) => current.map((document) => {
        const found = results.find((result) => result.path === document.path);
        return found?.file && found.hash === document.hash ? mergeFile(document, found.file) : document;
      }));
      checking = false;
    };
    const timer = window.setInterval(() => void check(), 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [api]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (documentsRef.current.some((document) => document.content !== document.savedContent)) event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);

  const openFile = async (path: string) => {
    const request = ++selectionRequest.current;
    try {
      if (!documentsRef.current.some((document) => document.path === path)) {
        const file = await api.readFile(path);
        setDocuments((current) => current.some((document) => document.path === path) ? current : [...current, { ...file, savedContent: file.content }]);
      }
      if (request === selectionRequest.current) setActivePath(path);
    } catch (error) { reportError(error); }
  };

  const saveDocuments = async (all: boolean) => {
    const pending = documentsRef.current.filter((document) => (all || document.path === activePath) && document.content !== document.savedContent);
    const conflict = pending.find((document) => document.conflict);
    if (conflict) throw new Error(`${conflict.path} 已在外部修改。当前编辑已保留，请先合并磁盘上的修改再运行。`);
    for (const document of pending) {
      const saved = await api.writeFile({ path: document.path, content: document.content, expectedHash: document.hash });
      setDocuments((current) => current.map((item) => item.path === saved.path ? { ...saved, content: item.content, savedContent: saved.content } : item));
    }
  };

  const perform = async (action: () => Promise<void>) => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    setNotice("");
    try { await action(); } catch (error) { reportError(error); }
    finally { operationPending.current = false; setBusy(false); }
  };

  const startOrStop = () => perform(async () => {
    setTerminalOpen(true);
    if (running && runId) { setRun(await api.cancelRun(runId)); return; }
    if (!active) return;
    await saveDocuments(true);
    const started = await api.startRun({ entrypoint: active.path, name: active.path, inputs: {}, hardwareIds: [] });
    setRun(started);
    setRunId(started.runId);
  });

  const createScript = async () => {
    if (operationPending.current) return;
    const name = scriptName.trim();
    if (!name || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || (name.includes(".") && !/\.py$/i.test(name)) || name.toLowerCase() === ".py") {
      setCreateError("请输入有效的 Python 文件名，例如 test.py。");
      return;
    }
    const filename = /\.py$/i.test(name) ? `${name.slice(0, -3)}.py` : `${name}.py`;
    const path = `scripts/${filename}`;
    if (scripts.some((file) => file.path.toLowerCase() === path.toLowerCase())) {
      setCreateError("同名脚本已存在，请换一个名称。");
      return;
    }
    operationPending.current = true;
    setBusy(true);
    setCreateError("");
    try {
      await api.createFile({ path, kind: "file", content: "def main(inputs):\n    return {}\n" });
      setNewScriptOpen(false);
      await files.refetch();
      await openFile(path);
    } catch (error) {
      setCreateError((error as { category?: string } | null)?.category === "conflict" ? "同名脚本已存在，请换一个名称。" : errorMessage(error));
    } finally { operationPending.current = false; setBusy(false); }
  };

  return <FeatureLayout sidebar={{ position: "left", width, content: (
    <div className="flex flex-col gap-2">
    <Button size="sm" variant="ghost" className="self-start" disabled={!restored || busy} onClick={() => { setScriptName(""); setCreateError(""); setNewScriptOpen(true); }}><FilePlusIcon />新建脚本</Button>
    <div role="listbox" aria-label="Python 脚本列表" className="flex flex-col gap-0.5" aria-busy={files.isLoading}>
      {scripts.map((file, index) => <button
        key={file.path} type="button" role="option" aria-selected={activePath === file.path}
        tabIndex={activePath === file.path || (!scripts.some((script) => script.path === activePath) && index === 0) ? 0 : -1}
        disabled={!restored} title={file.path}
        className={`w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${activePath === file.path ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
        onClick={() => void openFile(file.path)}
        onKeyDown={(event) => {
          const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? scripts.length - 1 : undefined;
          if (next === undefined) return;
          event.preventDefault();
          const bounded = Math.max(0, Math.min(scripts.length - 1, next));
          (event.currentTarget.parentElement?.children[bounded] as HTMLElement | undefined)?.focus();
          void openFile(scripts[bounded]!.path);
        }}
      >{file.path.replace(/^scripts\//, "")}{documents.some((document) => document.path === file.path && document.content !== document.savedContent) ? " ●" : ""}</button>)}
      {!scripts.length && <p className="px-2 text-xs text-muted-foreground">{files.isLoading ? "正在加载…" : "暂无 Python 脚本"}</p>}
    </div>
    </div>
  ) }}>
    <section aria-label="脚本编辑区" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-11 flex-none items-center justify-end px-3">
        <Button size="sm" variant="ghost" disabled={busy || run?.status === "cancelling" || (!running && !active)} onClick={() => void startOrStop()}>
          {running ? <SquareIcon /> : <PlayIcon />}{running ? "停止" : "运行"}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {active ? <CodeEditor path={active.path} value={active.content} readOnly={busy} onChange={(content) => setDocuments((current) => current.map((document) => document.path === active.path ? updateTab(document, content) : document))} onSave={() => void perform(() => saveDocuments(false))} />
          : <div className="grid h-full place-items-center text-xs text-muted-foreground">从左侧选择脚本</div>}
      </div>
    </section>
    <ScriptTerminal runId={runId} notice={notice} open={terminalOpen} onOpenChange={setTerminalOpen} onRunChange={setRun} />
    <Dialog open={newScriptOpen} onOpenChange={(open) => { if (!busy) setNewScriptOpen(open); }}>
      <DialogContent size="sm" aria-describedby={undefined}>
        <form onSubmit={(event) => { event.preventDefault(); void createScript(); }}>
          <DialogHeader title="新建脚本" onClose={() => setNewScriptOpen(false)} />
          <DialogBody>
            <label className="flex flex-col gap-2 text-xs">脚本名称
              <Input autoFocus required placeholder="new_script.py" value={scriptName} disabled={busy} onChange={(event) => { setScriptName(event.target.value); setCreateError(""); }} />
            </label>
            {createError && <p role="alert" className="mt-2 text-xs text-destructive">{createError}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setNewScriptOpen(false)}>取消</Button>
            <Button type="submit" disabled={busy || !scriptName.trim()}>{busy ? "创建中…" : "创建"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </FeatureLayout>;
}
