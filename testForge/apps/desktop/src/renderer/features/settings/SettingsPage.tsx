import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { OpenCodeRuntimeStatus } from "@testforge/contracts/agents";
import type { DashboardSnapshot } from "@testforge/contracts/desktop";
import { ArrowLeftIcon, BotIcon, EyeIcon, EyeOffIcon, PaletteIcon, PlugZapIcon, RefreshCwIcon, Settings2Icon, SquareIcon } from "lucide-react";
import { Btn, Badge } from "../../shared/ui.js";
import { QueryGate } from "../../shared/layout.js";
import { errorMessage } from "../../shared/errors.js";
import { queryKeys } from "../../shared/query-keys.js";
import type { ThemeChoice } from "@testforge/contracts/storage";
import { AgentIntegrationPage } from "../agent/AgentIntegrationPage.js";

type SettingsSection = "appearance" | "model" | "agents";

export function SettingsPage({ dashboard, theme, onThemeChange, onBack }: {
  dashboard: UseQueryResult<DashboardSnapshot>;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => Promise<void>;
  onBack: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>("appearance");
  return (
    <main className="settings-page">
      <aside className="settings-nav" aria-label="设置分类">
        <button className="settings-back" onClick={onBack}><ArrowLeftIcon size={15} /><span>返回</span></button>
        <div className="settings-nav-title"><Settings2Icon size={16} /><strong>设置</strong></div>
        <SettingsNavButton active={section === "appearance"} icon={<PaletteIcon size={15} />} label="外观" onClick={() => setSection("appearance")} />
        <SettingsNavButton active={section === "model"} icon={<BotIcon size={15} />} label="AI 模型" onClick={() => setSection("model")} />
        <SettingsNavButton active={section === "agents"} icon={<PlugZapIcon size={15} />} label="Agent 接入" onClick={() => setSection("agents")} />
      </aside>
      <div className="settings-content">
        {section === "appearance" && <AppearanceSettings value={theme} onChange={onThemeChange} />}
        {section === "model" && <ModelSettings />}
        {section === "agents" && <QueryGate query={dashboard}>{(data) => <AgentIntegrationPage query={dashboard} gateway={data.gateway} embedded />}</QueryGate>}
      </div>
    </main>
  );
}

function SettingsNavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return <button className={active ? "active" : ""} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function AppearanceSettings({ value, onChange }: { value: ThemeChoice; onChange: (theme: ThemeChoice) => Promise<void> }) {
  const choices: Array<{ value: ThemeChoice; title: string; body: string }> = [
    { value: "system", title: "跟随系统", body: "随操作系统自动切换浅色或深色。" },
    { value: "light", title: "浅色", body: "始终使用浅色界面。" },
    { value: "dark", title: "深色", body: "始终使用深色界面。" }
  ];
  return <SettingsSection title="外观" description="选择 TestForge 的界面主题。"><div className="theme-choice-grid">{choices.map((choice) => <button key={choice.value} className={value === choice.value ? "active" : ""} aria-pressed={value === choice.value} onClick={() => void onChange(choice.value)}><span className={`theme-swatch ${choice.value}`}><i /><i /><i /></span><strong>{choice.title}</strong><small>{choice.body}</small></button>)}</div></SettingsSection>;
}

function ModelSettings() {
  const settings = useQuery({ queryKey: queryKeys.llmSettings, queryFn: () => window.testforge.settings.getLlm() });
  const runtime = useQuery({ queryKey: queryKeys.openCodeStatus, queryFn: () => window.testforge.agents.openCodeStatus(), refetchInterval: 5_000 });
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-4.1");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!settings.data) return;
    setBaseUrl(settings.data.baseUrl);
    setModel(settings.data.model);
  }, [settings.data]);
  useEffect(() => window.testforge.events.subscribe("opencode", () => { void runtime.refetch(); }), [runtime]);

  const refresh = async () => { await Promise.all([settings.refetch(), runtime.refetch()]); };
  const save = useMutation({
    mutationFn: (clearApiKey: boolean) => window.testforge.settings.saveLlm({ baseUrl, model, apiKey, clearApiKey }),
    onSuccess: async () => { setApiKey(""); setShowKey(false); setError(undefined); setNotice("模型配置已保存。"); await refresh(); },
    onError: (reason) => setError(errorMessage(reason))
  });
  const runtimeAction = useMutation({
    mutationFn: (action: "start" | "stop" | "restart") => action === "start" ? window.testforge.agents.startOpenCode() : action === "stop" ? window.testforge.agents.stopOpenCode() : window.testforge.agents.restartOpenCode(),
    onSuccess: async () => { setError(undefined); await runtime.refetch(); },
    onError: (reason) => setError(errorMessage(reason))
  });
  const submit = (event: FormEvent) => { event.preventDefault(); setNotice(undefined); save.mutate(false); };
  const status = runtime.data;
  const busy = save.isPending || runtimeAction.isPending || status?.state === "starting" || status?.state === "stopping";

  return <SettingsSection title="AI 模型" description="配置 OpenAI 兼容模型，并管理当前项目的内嵌 OpenCode。">
    {(error || settings.isError || runtime.isError) && <div className="alert">{error ?? errorMessage(settings.error ?? runtime.error)}</div>}
    {notice && <div className="agent-notice success">{notice}</div>}
    <form className="settings-form" onSubmit={submit}>
      <label className="field"><span className="field-label">Base URL</span><input className="input" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></label>
      <label className="field"><span className="field-label">模型 ID</span><input className="input" value={model} onChange={(event) => setModel(event.target.value)} required /></label>
      <label className="field"><span className="field-label">API Key</span><span className="secret-input"><input className="input" type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.data?.apiKeyConfigured ? "已配置，留空则保持不变" : "输入 API Key"} /><button type="button" aria-label={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey((show) => !show)}>{showKey ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}</button></span></label>
      <div className="settings-form-actions">{settings.data?.apiKeyConfigured && <Btn type="button" variant="danger" disabled={busy} onClick={() => save.mutate(true)}>清除密钥</Btn>}<Btn type="submit" variant="primary" disabled={busy || !baseUrl.trim() || !model.trim()}>保存配置</Btn></div>
    </form>

    <section className="runtime-panel">
      <header><div><strong>OpenCode</strong><span>{status?.version ? `版本 ${status.version}` : "内嵌运行时"}</span></div><Badge tone={runtimeTone(status)}>{runtimeLabel(status)}</Badge></header>
      <dl><div><dt>工作区</dt><dd>{status?.workspace ?? "需要先打开项目"}</dd></div><div><dt>状态</dt><dd>{status?.message ?? (status?.workspaceState === "requires_project" ? "无活动项目时保持停止" : "就绪")}</dd></div></dl>
      <footer>
        {(status?.state === "stopped" || status?.state === "error") && <Btn icon={<BotIcon size={14} />} disabled={busy || status.workspaceState === "requires_project" || !settings.data?.apiKeyConfigured} onClick={() => runtimeAction.mutate("start")}>启动</Btn>}
        {status?.state === "running" && <Btn icon={<RefreshCwIcon size={14} />} disabled={busy} onClick={() => runtimeAction.mutate("restart")}>重启</Btn>}
        {(status?.state === "running" || status?.state === "starting" || status?.state === "error") && <Btn icon={<SquareIcon size={13} />} disabled={runtimeAction.isPending} onClick={() => runtimeAction.mutate("stop")}>停止</Btn>}
      </footer>
    </section>
  </SettingsSection>;
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="settings-section"><header><h1>{title}</h1><p>{description}</p></header>{children}</section>;
}

function runtimeTone(status?: OpenCodeRuntimeStatus): "muted" | "ok" | "warn" | "bad" {
  if (status?.state === "running") return "ok";
  if (status?.state === "error") return "bad";
  if (status?.state === "starting" || status?.state === "stopping") return "warn";
  return "muted";
}
function runtimeLabel(status?: OpenCodeRuntimeStatus) {
  return ({ running: "运行中", starting: "启动中", stopping: "停止中", stopped: "已停止", error: "启动失败" } as Record<string, string>)[status?.state ?? ""] ?? "读取中";
}
