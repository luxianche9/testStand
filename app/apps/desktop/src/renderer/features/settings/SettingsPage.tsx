import { useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { DashboardSnapshot } from "@teststand/contracts/operations";
import type { ThemeChoice } from "@teststand/contracts/storage";
import { ArrowLeftIcon, BotIcon, PaletteIcon, PlugZapIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { Button, Spinner, cn } from "../../ui";
import { AgentIntegrationPage } from "./AgentIntegrationPage.js";
import { AppearanceSettings } from "./AppearanceSettings.js";
import { ModelSettings } from "./ModelSettings.js";
import { Notice } from "./SettingsLayout.js";

type SettingsSection = "appearance" | "model" | "agents";

const sections: Array<{ id: SettingsSection; label: string; hint: string; icon: ReactNode }> = [
  { id: "appearance", label: "外观", hint: "主题", icon: <PaletteIcon /> },
  { id: "model", label: "AI 模型", hint: "LLM · OpenCode", icon: <BotIcon /> },
  { id: "agents", label: "Agent 接入", hint: "MCP · Codex", icon: <PlugZapIcon /> }
];

export function SettingsPage({ dashboard, theme, onThemeChange, onBack }: {
  dashboard: UseQueryResult<DashboardSnapshot>;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => Promise<void>;
  onBack: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>("appearance");
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[216px_minmax(0,1fr)] bg-surface-0">
      <nav aria-label="设置分类" className="flex min-h-0 flex-col gap-1 border-r border-line bg-surface-1 p-2">
        <Button variant="ghost" className="justify-start" onClick={onBack}>
          <ArrowLeftIcon />
          返回
        </Button>
        <span className="tf-label mt-3 mb-1 px-2">设置</span>
        {sections.map((item) => (
          <NavItem
            key={item.id}
            active={section === item.id}
            icon={item.icon}
            hint={item.hint}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </NavItem>
        ))}
      </nav>
      <div className="min-h-0 overflow-y-auto">
        <div key={section} className="mx-auto max-w-[800px] animate-fade-in px-8 pt-6 pb-16">
          {section === "appearance" && <AppearanceSettings value={theme} onChange={onThemeChange} />}
          {section === "model" && <ModelSettings />}
          {section === "agents" && <DashboardGate query={dashboard} />}
        </div>
      </div>
    </div>
  );
}

function NavItem({ active, icon, hint, onClick, children }: {
  active: boolean;
  icon: ReactNode;
  hint: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "relative flex h-9 items-center gap-2 rounded-md px-2 text-left text-sm text-fg-2 outline-none",
        "transition-colors duration-120 hover:bg-surface-2 hover:text-fg [&_svg]:size-3.5 [&_svg]:shrink-0",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal",
        active && "bg-surface-2 text-fg [&_svg]:text-signal"
      )}
    >
      {active && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-signal" />}
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span aria-hidden className="truncate font-mono text-2xs text-fg-3">{hint}</span>
    </button>
  );
}

/** The agent page needs the gateway snapshot; show loading / error states until it arrives. */
function DashboardGate({ query }: { query: UseQueryResult<DashboardSnapshot> }) {
  if (query.data) return <AgentIntegrationPage gateway={query.data.gateway} />;
  if (query.isError) {
    return (
      <div className="grid gap-3">
        <Notice tone="fail">{errorMessage(query.error)}</Notice>
        <div>
          <Button onClick={() => void query.refetch()}>重试</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid min-h-40 place-items-center text-fg-3">
      <Spinner label="正在读取 Gateway 状态…" />
    </div>
  );
}
