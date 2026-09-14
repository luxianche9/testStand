import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  BotIcon,
  CableIcon,
  ChevronDownIcon,
  ClipboardClockIcon,
  FolderIcon,
  InboxIcon,
  Maximize2Icon,
  MinusIcon,
  Minimize2Icon,
  Repeat2Icon,
  ServerIcon,
  SettingsIcon,
  XIcon
} from "lucide-react";
import type { ProjectDocument } from "@testforge/contracts/projects";
import type { ProjectView } from "@testforge/contracts/storage";
import { cn } from "../shared/ui/cn";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../shared/ui/dropdown-menu";
import type { AppPage } from "./app-navigation.js";

export function TitleBar({ page, projectView, project, assistantOpen, busy, pendingTaskCount, wiringLogOpen, onToggleWiringLog, onNavigate, onProjectAction, onToggleAssistant }: {
  page: AppPage;
  projectView: ProjectView;
  project: ProjectDocument | null | undefined;
  assistantOpen: boolean;
  busy: boolean;
  pendingTaskCount: number;
  wiringLogOpen: boolean;
  onToggleWiringLog: () => void;
  onNavigate: (page: AppPage) => void;
  onProjectAction: (action: "save" | "open" | "welcome") => void;
  onToggleAssistant: () => void;
}) {
  const [maximized, setMaximized] = useState(false);
  const inProject = page !== "welcome" && Boolean(project);

  useEffect(() => window.testforge.events.subscribe("window-state", (payload) => {
    const state = payload as { maximized?: boolean };
    if (typeof state.maximized === "boolean") setMaximized(state.maximized);
  }), []);

  const projectLabel = inProject && project ? project.file.name : "项目";
  return (
    <header className="relative flex h-11 flex-none items-center gap-0.5 bg-secondary/45 shadow-[inset_0_-1px_0_var(--tf-border)] backdrop-blur-md [-webkit-app-region:drag] select-none">
      <span className="flex items-center self-stretch px-3.5 text-[13px] font-semibold tracking-[-0.03em]">TestForge</span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="项目文件夹菜单"
            className="inline-flex h-[30px] max-w-[220px] items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground transition-[color,background-color,transform] duration-200 ease-[var(--tf-ease-out)] [-webkit-app-region:no-drag] hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          >
            <FolderIcon className="size-[15px]" />
            <span className="truncate">{projectLabel}{inProject && project?.dirty ? " *" : ""}</span>
            <ChevronDownIcon className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem disabled={busy} onSelect={() => onProjectAction("open")}>打开</DropdownMenuItem>
          {inProject && (
            <DropdownMenuItem disabled={busy} onSelect={() => onProjectAction("save")}>
              保存<span className="text-xs text-muted-foreground">Ctrl+S</span>
            </DropdownMenuItem>
          )}
          {inProject && <DropdownMenuItem disabled={busy} onSelect={() => onProjectAction("welcome")}>退出</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>

      <NavButton active={page === "settings"} label="设置" icon={<SettingsIcon className="size-[15px]" />} onClick={() => onNavigate("settings")} />

      {inProject ? <ViewSlider value={isProjectViewPage(page) ? page : projectView} onChange={onNavigate} /> : <span className="flex-1 self-stretch" />}

      <span className="flex-1 self-stretch" />

      <TitleBarAction
        label="信箱"
        active={wiringLogOpen}
        pressed={wiringLogOpen}
        onClick={onToggleWiringLog}
        icon={<InboxIcon className="size-4" />}
        badge={pendingTaskCount > 0 ? pendingTaskCount : undefined}
      />
      {inProject && (
        <TitleBarAction
          label="AI助手"
          ariaLabel={assistantOpen ? "关闭 AI 侧栏" : "打开 AI 侧栏"}
          active={assistantOpen}
          pressed={assistantOpen}
          onClick={onToggleAssistant}
          icon={<BotIcon className="size-4" />}
        />
      )}
      <button
        title="最小化"
        aria-label="最小化"
        className={winButtonClass}
        onClick={() => void window.testforge.window.minimize()}
      >
        <MinusIcon className="size-[15px]" />
      </button>
      <button
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
        className={winButtonClass}
        onClick={() => void window.testforge.window.toggleMaximize()}
      >
        {maximized ? <Minimize2Icon className="size-3.5" /> : <Maximize2Icon className="size-3.5" />}
      </button>
      <button
        title="关闭"
        aria-label="关闭"
        className={cn(winButtonClass, "hover:bg-[#e81123] hover:text-white")}
        onClick={() => void window.testforge.window.close()}
      >
        <XIcon className="size-[15px]" />
      </button>
    </header>
  );
}

const winButtonClass =
  "grid h-11 w-10 place-items-center text-muted-foreground transition-[color,background-color] duration-200 ease-[var(--tf-ease-out)] [-webkit-app-region:no-drag] hover:bg-accent hover:text-foreground";

function NavButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex h-[30px] items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground transition-[color,background-color] duration-200 ease-[var(--tf-ease-out)] [-webkit-app-region:no-drag] hover:bg-accent hover:text-foreground",
        active && "bg-accent font-medium text-foreground"
      )}
    >
      {icon}
      <span className="max-[1100px]:hidden">{label}</span>
    </button>
  );
}

function TitleBarAction({ label, ariaLabel, icon, active, pressed, badge, onClick }: {
  label: string;
  ariaLabel?: string | undefined;
  icon: ReactNode;
  active?: boolean | undefined;
  pressed?: boolean | undefined;
  badge?: number | undefined;
  onClick: () => void;
}) {
  return (
    <button
      title={ariaLabel ?? label}
      aria-label={ariaLabel ?? label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "relative mx-0.5 inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground transition-[color,background-color] duration-200 ease-[var(--tf-ease-out)] [-webkit-app-region:no-drag] hover:bg-accent hover:text-foreground",
        active && "bg-accent font-medium text-foreground"
      )}
    >
      {icon}
      <span className="max-[1100px]:hidden">{label}</span>
      {badge != null && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold tabular-nums text-destructive-foreground" aria-label={`${badge} 条待处理`}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

const PROJECT_VIEWS: { view: ProjectView; label: string; icon: ReactNode }[] = [
  { view: "manual", label: "设备管理", icon: <ServerIcon className="size-[15px]" /> },
  { view: "wiring", label: "工位接线", icon: <CableIcon className="size-[15px]" /> },
  { view: "orchestration", label: "编排测试", icon: <Repeat2Icon className="size-[15px]" /> },
  { view: "logs", label: "运行日志", icon: <ClipboardClockIcon className="size-[15px]" /> }
];

function isProjectViewPage(page: AppPage): page is ProjectView {
  return PROJECT_VIEWS.some((item) => item.view === page);
}

function ViewSlider({ value, onChange }: { value: ProjectView; onChange: (page: AppPage) => void }) {
  const railRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  const activeIndex = Math.max(0, PROJECT_VIEWS.findIndex((item) => item.view === value));
  useLayoutEffect(() => {
    const update = () => {
      const rail = railRef.current;
      const item = itemRefs.current[activeIndex];
      if (!rail || !item) return;
      setThumb({ left: item.offsetLeft, width: item.offsetWidth });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [activeIndex]);

  return (
    <div
      role="tablist"
      aria-label="项目子页面"
      ref={railRef}
      className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-0.5 rounded-xl bg-foreground/[0.04] p-0.5 shadow-[var(--tf-shadow-sm)] ring-1 ring-border [-webkit-app-region:no-drag]"
    >
      {thumb && (
        <span
          aria-hidden="true"
          className="absolute top-0.5 bottom-0.5 rounded-lg bg-background shadow-[var(--tf-shadow-sm)] ring-1 ring-border/50 transition-[left,width] duration-250 ease-[var(--tf-ease-out)]"
          style={{ left: thumb.left, width: thumb.width }}
        />
      )}
      {PROJECT_VIEWS.map((item, index) => (
        <button
          key={item.view}
          role="tab"
          aria-selected={index === activeIndex}
          ref={(node) => { itemRefs.current[index] = node; }}
          onClick={() => onChange(item.view)}
          className={cn(
            "relative z-[1] inline-flex h-[26px] items-center gap-1.5 rounded-lg px-2.5 text-xs whitespace-nowrap text-muted-foreground transition-colors duration-200 ease-[var(--tf-ease-out)] hover:text-foreground",
            index === activeIndex && "font-medium text-foreground"
          )}
        >
          {item.icon}
          <span className="max-[1100px]:hidden">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
