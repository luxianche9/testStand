import type { ReactNode } from "react";
import {
  BotIcon,
  CableIcon,
  ChevronDownIcon,
  FlaskConicalIcon,
  Maximize2Icon,
  Minimize2Icon,
  MinusIcon,
  ScrollTextIcon,
  SettingsIcon,
  XIcon
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectDocument } from "@teststand/contracts/projects";
import type { ProjectView } from "@teststand/contracts/storage";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, cn } from "../ui";
import type { AppPage } from "./app-navigation.js";

const PROJECT_VIEWS: { view: ProjectView; label: string; icon: ReactNode }[] = [
  { view: "bench", label: "测试台架", icon: <CableIcon /> },
  { view: "plans", label: "测试编排", icon: <FlaskConicalIcon /> },
  { view: "runs", label: "运行监控", icon: <ScrollTextIcon /> }
];

export type ProjectAction = "save" | "open" | "welcome";

const noDrag = "[-webkit-app-region:no-drag]";
const barButton = cn(
  "relative inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg-2 transition-colors duration-120",
  "hover:bg-surface-2 hover:text-fg aria-pressed:bg-surface-2 aria-pressed:text-fg [&_svg]:size-3.5",
  noDrag
);

export function TitleBar(props: {
  page: AppPage;
  projectView: ProjectView;
  project: ProjectDocument | null | undefined;
  assistantOpen: boolean;
  busy: boolean;
  /** Open wiring requests, counted on the 测试台架 tab. */
  pendingTaskCount: number;
  onNavigate: (page: AppPage) => void;
  onProjectAction: (action: ProjectAction) => void;
  onToggleAssistant: () => void;
}) {
  const { page, project, busy } = props;
  const inProject = page !== "welcome" && Boolean(project);
  const activeView = PROJECT_VIEWS.some((item) => item.view === page) ? (page as ProjectView) : props.projectView;

  return (
    <header
      className={cn(
        "relative flex h-9 flex-none items-center gap-1 border-b border-line bg-surface-1 pl-2",
        "select-none [-webkit-app-region:drag]"
      )}
    >
      <Brand />
      <Menu>
        <MenuTrigger asChild>
          <button type="button" aria-label="项目文件夹菜单" className={cn(barButton, "max-w-60")}>
            <span className="truncate font-medium text-fg">{inProject && project ? project.file.name : "项目"}</span>
            {inProject && project?.dirty && <span aria-hidden className="size-1.5 rounded-full bg-signal" />}
            <ChevronDownIcon className="!size-3 text-fg-3" />
          </button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem disabled={busy} onSelect={() => props.onProjectAction("open")}>打开</MenuItem>
          {inProject && (
            <MenuItem disabled={busy} shortcut="Ctrl+S" onSelect={() => props.onProjectAction("save")}>保存</MenuItem>
          )}
          {inProject && <MenuSeparator />}
          {inProject && (
            <MenuItem disabled={busy} onSelect={() => props.onProjectAction("welcome")}>退出</MenuItem>
          )}
        </MenuContent>
      </Menu>

      {inProject && (
        <ViewTabs
          value={activeView}
          dimmed={page === "settings"}
          pendingTaskCount={props.pendingTaskCount}
          onChange={props.onNavigate}
        />
      )}
      <span className="flex-1 self-stretch" />

      {inProject && (
        <button
          type="button"
          aria-label={props.assistantOpen ? "关闭 AI 侧栏" : "打开 AI 侧栏"}
          aria-pressed={props.assistantOpen}
          onClick={props.onToggleAssistant}
          className={barButton}
        >
          <BotIcon />
          <span className="max-[1100px]:hidden">AI助手</span>
        </button>
      )}
      <button
        type="button"
        aria-label="设置"
        aria-pressed={page === "settings"}
        onClick={() => props.onNavigate("settings")}
        className={barButton}
      >
        <SettingsIcon />
      </button>
      <span aria-hidden className="mx-1 h-4 w-px bg-line" />
      <WindowControls />
    </header>
  );
}

function Brand() {
  return (
    <span className="mr-1 flex items-center gap-2 px-1">
      <span
        aria-hidden
        className={cn(
          "grid size-5 place-items-center rounded-xs bg-signal",
          "text-[10px] leading-none font-bold text-signal-fg"
        )}
      >
        TS
      </span>
      <span className="text-sm font-semibold text-fg max-[1100px]:hidden">testStand</span>
      <span aria-hidden className="text-fg-3">/</span>
    </span>
  );
}

function ViewTabs({ value, dimmed, pendingTaskCount, onChange }: {
  value: ProjectView;
  /** Settings is open: keep the last view selected for AT but drop its highlight. */
  dimmed: boolean;
  pendingTaskCount: number;
  onChange: (page: AppPage) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="项目子页面"
      className={cn(
        "absolute top-0 left-1/2 flex h-full -translate-x-1/2 items-stretch",
        noDrag
      )}
    >
      {PROJECT_VIEWS.map((item) => {
        const selected = item.view === value;
        const lit = selected && !dimmed;
        return (
          <button
            key={item.view}
            type="button"
            role="tab"
            aria-label={item.label}
            aria-selected={selected}
            onClick={() => onChange(item.view)}
            className={cn(
              "relative inline-flex items-center gap-1.5 px-3 text-xs whitespace-nowrap text-fg-2",
              "transition-colors duration-120 hover:text-fg [&_svg]:size-3.5",
              "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:content-['']",
              lit ? "bg-surface-0 font-medium text-fg after:bg-signal" : "hover:bg-surface-2 after:bg-transparent"
            )}
          >
            <span className={lit ? "text-signal" : "text-fg-3"}>{item.icon}</span>
            <span className="max-[1100px]:hidden">{item.label}</span>
            {item.view === "bench" && pendingTaskCount > 0 && (
              <span
                aria-label={`${pendingTaskCount} 条待处理接线任务`}
                className="tf-num rounded-xs bg-signal px-1 text-2xs leading-4 font-semibold text-signal-fg"
              >
                {pendingTaskCount > 99 ? "99+" : pendingTaskCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => window.teststand.events.subscribe("window-state", (payload) => {
    const state = payload as { maximized?: boolean };
    if (typeof state.maximized === "boolean") setMaximized(state.maximized);
  }), []);
  const base = cn(
    "grid h-9 w-11 place-items-center text-fg-2 transition-colors duration-120 hover:bg-surface-2 hover:text-fg",
    "[&_svg]:size-3.5",
    noDrag
  );
  return (
    <div className="flex self-stretch">
      <button type="button" title="最小化" aria-label="最小化" className={base}
        onClick={() => void window.teststand.window.minimize()}>
        <MinusIcon />
      </button>
      <button type="button" title={maximized ? "还原" : "最大化"} aria-label={maximized ? "还原" : "最大化"}
        className={base} onClick={() => void window.teststand.window.toggleMaximize()}>
        {maximized ? <Minimize2Icon /> : <Maximize2Icon />}
      </button>
      <button type="button" title="关闭" aria-label="关闭" className={cn(base, "hover:bg-[#c42b1c] hover:text-white")}
        onClick={() => void window.teststand.window.close()}>
        <XIcon />
      </button>
    </div>
  );
}
