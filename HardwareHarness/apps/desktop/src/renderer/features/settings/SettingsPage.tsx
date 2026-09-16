import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { OpenCodeRuntimeStatus } from "@hardwareharness/contracts/agents";
import type { DashboardSnapshot } from "@hardwareharness/contracts/desktop";
import { ArrowLeftIcon, BotIcon, EyeIcon, EyeOffIcon, PaletteIcon, PlugZapIcon, RefreshCwIcon, Settings2Icon, SquareIcon } from "lucide-react";
import { Badge, badgeVariantFromTone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Field, Input } from "../../shared/ui/input";
import { cn } from "../../shared/ui/cn";
import { QueryGate } from "../../shared/layout.js";
import { errorMessage } from "../../shared/errors.js";
import { queryKeys } from "../../shared/query-keys.js";
import type { ThemeChoice } from "@hardwareharness/contracts/storage";
import { AgentIntegrationPage } from "./AgentIntegrationPage.js";

type SettingsSection = "appearance" | "model" | "agents";

export function SettingsPage({ dashboard, theme, onThemeChange, onBack }: {
  dashboard: UseQueryResult<DashboardSnapshot>;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => Promise<void>;
  onBack: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>("appearance");
  return (
    <main className="grid min-h-0 flex-1 grid-cols-[210px_minmax(0,1fr)] bg-background">
      <aside className="min-h-0 border-r border-border bg-secondary/50 px-2.5 py-3.5" aria-label="设置分类">
        <button className="mb-1.5 flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={onBack}><ArrowLeftIcon size={15} /><span>返回</span></button>
        <div className="flex h-8 items-center gap-2 px-2 pb-2 text-muted-foreground"><Settings2Icon size={16} /><strong className="text-sm font-semibold text-foreground">设置</strong></div>
        <SettingsNavButton active={section === "appearance"} icon={<PaletteIcon size={15} />} label="外观" onClick={() => setSection("appearance")} />
        <SettingsNavButton active={section === "model"} icon={<BotIcon size={15} />} label="AI 模型" onClick={() => setSection("model")} />
        <SettingsNavButton active={section === "agents"} icon={<PlugZapIcon size={15} />} label="Agent 接入" onClick={() => setSection("agents")} />
      </aside>
      <div className="min-h-0 overflow-y-auto px-6 pt-7 pb-18 md:px-10">
        <div className="animate-page-in">
          {section === "appearance" && <AppearanceSettings value={theme} onChange={onThemeChange} />}
          {section === "model" && <ModelSettings />}
          {section === "agents" && <QueryGate query={dashboard}>{(data) => <AgentIntegrationPage query={dashboard} gateway={data.gateway} embedded />}</QueryGate>}
        </div>
      </div>
    </main>
  );
}

function SettingsNavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      className={cn(
        "relative flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
        active && "bg-accent font-medium text-primary hover:text-primary"
      )}
      onClick={onClick}
    >
      {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full bg-primary" />}
      {icon}<span>{label}</span>
    </button>
  );
}

function AppearanceSettings({ value, onChange }: { value: ThemeChoice; onChange: (theme: ThemeChoice) => Promise<void> }) {
  const choices: Array<{ value: ThemeChoice; title: string; body: string; swatch: string }> = [
    { value: "system", title: "跟随系统", body: "随操作系统自动切换浅色或深色。", swatch: "linear-gradient(90deg,#fafafa 0 50%,#262626 50%),linear-gradient(90deg,#e5e5e5 0 50%,#0a0a0a 50%),linear-gradient(90deg,#fff 0 50%,#171717 50%)" },
    { value: "light", title: "浅色", body: "始终使用浅色界面。", swatch: "#fafafa,#e5e5e5,#fff" },
    { value: "dark", title: "深色", body: "始终使用深色界面。", swatch: "#262626,#0a0a0a,#171717" }
  ];
  return (
    <SettingsSection title="外观" description="选择 HardwareHarness 的界面主题。">
      <div className="grid grid-cols-3 gap-3">
        {choices.map((choice) => (
          <button
            key={choice.value}
            className={cn(
              "grid gap-2 rounded-xl bg-card p-3 text-left shadow-sm ring-1 ring-border transition-[box-shadow,ring-color] hover:ring-primary/40",
              value === choice.value && "ring-2 ring-primary/50"
            )}
            aria-pressed={value === choice.value}
            onClick={() => void onChange(choice.value)}
          >
            {/* 主题预览色块刻意使用真实预览色,不经设计 token。 */}
            <span className="grid h-[74px] grid-cols-[24%_1fr] grid-rows-[22px_1fr] overflow-hidden rounded-lg bg-secondary/40 ring-1 ring-border">
              {choice.swatch.split(",").map((background, index) => (
                <i key={index} className={index === 0 ? "col-span-2" : undefined} style={{ background }} />
              ))}
            </span>
            <strong className="text-sm font-medium">{choice.title}</strong>
            <small className="text-xs leading-snug text-muted-foreground">{choice.body}</small>
          </button>
        ))}
      </div>
    </SettingsSection>
  );
}

function ModelSettings() {
  const settings = useQuery({ queryKey: queryKeys.llmSettings, queryFn: () => window.hardwareharness.settings.getLlm() });
  const runtime = useQuery({ queryKey: queryKeys.openCodeStatus, queryFn: () => window.hardwareharness.agents.openCodeStatus(), refetchInterval: 5_000 });
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
  useEffect(() => window.hardwareharness.events.subscribe("opencode", () => { void runtime.refetch(); }), [runtime]);

  const refresh = async () => { await Promise.all([settings.refetch(), runtime.refetch()]); };
  const save = useMutation({
    mutationFn: (clearApiKey: boolean) => window.hardwareharness.settings.saveLlm({ baseUrl, model, apiKey, clearApiKey }),
    onSuccess: async () => { setApiKey(""); setShowKey(false); setError(undefined); setNotice("模型配置已保存。"); await refresh(); },
    onError: (reason) => setError(errorMessage(reason))
  });
  const runtimeAction = useMutation({
    mutationFn: (action: "start" | "stop" | "restart") => action === "start" ? window.hardwareharness.agents.startOpenCode() : action === "stop" ? window.hardwareharness.agents.stopOpenCode() : window.hardwareharness.agents.restartOpenCode(),
    onSuccess: async () => { setError(undefined); await runtime.refetch(); },
    onError: (reason) => setError(errorMessage(reason))
  });
  const submit = (event: FormEvent) => { event.preventDefault(); setNotice(undefined); save.mutate(false); };
  const status = runtime.data;
  const busy = save.isPending || runtimeAction.isPending || status?.state === "starting" || status?.state === "stopping";

  return <SettingsSection title="AI 模型" description="配置 OpenAI 兼容模型，并管理当前项目的内嵌 OpenCode。">
    {(error || settings.isError || runtime.isError) && <div className="mb-4 flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/10 px-3.5 py-2.5 text-xs whitespace-pre-wrap break-anywhere text-destructive">{error ?? errorMessage(settings.error ?? runtime.error)}</div>}
    {notice && <div className="mb-4 rounded-md border border-success/35 bg-success/10 px-3.5 py-2.5 text-xs text-success">{notice}</div>}
    <form className="grid gap-3.5 rounded-xl bg-card p-4 shadow-sm ring-1 ring-border" onSubmit={submit}>
      <Field label="Base URL"><Input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></Field>
      <Field label="模型 ID"><Input value={model} onChange={(event) => setModel(event.target.value)} required /></Field>
      <Field label="API Key">
        <span className="relative block">
          <Input className="pr-10" type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.data?.apiKeyConfigured ? "已配置，留空则保持不变" : "输入 API Key"} />
          <button className="absolute top-0 right-0 grid h-9 w-9 place-items-center text-muted-foreground hover:text-foreground" type="button" aria-label={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey((show) => !show)}>{showKey ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}</button>
        </span>
      </Field>
      <div className="flex justify-end gap-2">{settings.data?.apiKeyConfigured && <Button type="button" variant="destructive" disabled={busy} onClick={() => save.mutate(true)}>清除密钥</Button>}<Button type="submit" disabled={busy || !baseUrl.trim() || !model.trim()}>保存配置</Button></div>
    </form>

    <section className="mt-4 overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border">
      <header className="flex items-center justify-between bg-secondary/50 px-4 py-3"><div className="grid gap-0.5"><strong className="text-sm font-semibold">OpenCode</strong><span className="text-[11px] text-muted-foreground">{status?.version ? `版本 ${status.version}` : "内嵌运行时"}</span></div><Badge variant={badgeVariantFromTone(runtimeTone(status))}>{runtimeLabel(status)}</Badge></header>
      <dl className="m-0 text-sm"><div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 px-4 py-2.5 odd:bg-secondary/20"><dt className="text-muted-foreground">工作区</dt><dd className="m-0 break-anywhere">{status?.workspace ?? "需要先打开项目"}</dd></div><div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 px-4 py-2.5 odd:bg-secondary/20"><dt className="text-muted-foreground">状态</dt><dd className="m-0 break-anywhere">{status?.message ?? (status?.workspaceState === "requires_project" ? "无活动项目时保持停止" : "就绪")}</dd></div></dl>
      <footer className="flex gap-2 bg-secondary/30 px-4 py-3">
        {(status?.state === "stopped" || status?.state === "error") && <Button variant="outline" size="sm" disabled={busy || status.workspaceState === "requires_project" || !settings.data?.apiKeyConfigured} onClick={() => runtimeAction.mutate("start")}><BotIcon size={14} />启动</Button>}
        {status?.state === "running" && <Button variant="outline" size="sm" disabled={busy} onClick={() => runtimeAction.mutate("restart")}><RefreshCwIcon size={14} />重启</Button>}
        {(status?.state === "running" || status?.state === "starting" || status?.state === "error") && <Button variant="outline" size="sm" disabled={runtimeAction.isPending} onClick={() => runtimeAction.mutate("stop")}><SquareIcon size={13} />停止</Button>}
      </footer>
    </section>
  </SettingsSection>;
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="mx-auto max-w-[880px]">
      <header className="mb-6 border-b border-border pb-4">
        <h1 className="m-0 text-[20px] font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 mb-0 max-w-[65ch] text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  );
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
