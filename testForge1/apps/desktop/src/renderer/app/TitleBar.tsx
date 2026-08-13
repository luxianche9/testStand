import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  BotIcon,
  CableIcon,
  ChevronDownIcon,
  ClipboardClockIcon,
  FolderIcon,
  InboxIcon,
  MinusIcon,
  MousePointerClickIcon,
  Repeat2Icon,
  SettingsIcon,
  SquareIcon,
  XIcon
} from "lucide-react";
import type { ProjectDocument } from "@testforge/contracts/projects";
import type { ProjectView } from "../features/projects/ProjectWorkspace.js";
import { IconMaximize, IconRestore } from "../shared/icons.js";
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
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inProject = page !== "welcome" && Boolean(project);

  useEffect(() => window.testforge.events.subscribe("window-state", (payload) => {
    const state = payload as { maximized?: boolean };
    if (typeof state.maximized === "boolean") setMaximized(state.maximized);
  }), []);
  useEffect(() => {
    if (!projectMenuOpen) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [projectMenuOpen]);

  const projectLabel = inProject && project ? project.file.name : "项目";
  return (
    <header className="titlebar">
      <span className="brand-button">TestForge</span>
      <div className="top-project-menu" ref={menuRef}>
        <button className={`top-nav-item project${projectMenuOpen ? " active" : ""}`} aria-label="项目文件夹菜单" aria-haspopup="menu" aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((open) => !open)}>
          <FolderIcon size={15} /><span>{projectLabel}{inProject && project?.dirty ? " *" : ""}</span><ChevronDownIcon size={12} />
        </button>
        {projectMenuOpen && <div className="file-menu-panel top-menu-panel" role="menu">
          <button role="menuitem" disabled={busy} onClick={() => { setProjectMenuOpen(false); onProjectAction("open"); }}>打开</button>
          {inProject && <button role="menuitem" disabled={busy} onClick={() => { setProjectMenuOpen(false); onProjectAction("save"); }}>保存<span>Ctrl+S</span></button>}
          {inProject && <button role="menuitem" disabled={busy} onClick={() => { setProjectMenuOpen(false); onProjectAction("welcome"); }}>退出</button>}
        </div>}
      </div>
      <NavButton active={page === "settings"} label="设置" icon={<SettingsIcon size={15} />} onClick={() => onNavigate("settings")} />

      {inProject ? <ViewSlider value={isProjectViewPage(page) ? page : projectView} onChange={onNavigate} /> : <span className="titlebar-drag" />}

      <span className="titlebar-drag" />
      {inProject && <button className={`titlebar-btn wiring-tasks${wiringLogOpen ? " active" : ""}`} title="接线调用历史" aria-label="接线调用历史" aria-pressed={wiringLogOpen} onClick={onToggleWiringLog}>
        <InboxIcon size={16} /><span>接线任务</span>{pendingTaskCount > 0 && <span className="titlebar-dot" aria-hidden="true" />}
      </button>}
      {inProject && <button className={`titlebar-btn assistant${assistantOpen ? " active" : ""}`} title={assistantOpen ? "关闭 AI 侧栏" : "打开 AI 侧栏"} aria-label={assistantOpen ? "关闭 AI 侧栏" : "打开 AI 侧栏"} aria-pressed={assistantOpen} onClick={onToggleAssistant}><BotIcon size={16} /><span>AI助手</span></button>}
      <button className="titlebar-btn win" title="最小化" aria-label="最小化" onClick={() => void window.testforge.window.minimize()}><MinusIcon size={15} /></button>
      <button className="titlebar-btn win" title={maximized ? "还原" : "最大化"} aria-label={maximized ? "还原" : "最大化"} onClick={() => void window.testforge.window.toggleMaximize()}>{maximized ? <IconRestore size={14} /> : <IconMaximize size={14} />}</button>
      <button className="titlebar-btn win close" title="关闭" aria-label="关闭" onClick={() => void window.testforge.window.close()}><XIcon size={15} /></button>
    </header>
  );
}

function NavButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: ReactNode; onClick: () => void }) {
  return <button className={`top-nav-item${active ? " active" : ""}`} onClick={onClick}>{icon}<span>{label}</span></button>;
}

const PROJECT_VIEWS: { view: ProjectView; label: string; icon: ReactNode }[] = [
  { view: "wiring", label: "工位接线", icon: <CableIcon size={15} /> },
  { view: "orchestration", label: "编排测试", icon: <Repeat2Icon size={15} /> },
  { view: "manual", label: "手动控制", icon: <MousePointerClickIcon size={15} /> },
  { view: "logs", label: "运行日志", icon: <ClipboardClockIcon size={15} /> }
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
    <div className="view-slider" role="tablist" aria-label="项目子页面" ref={railRef}>
      {thumb && <span className="view-slider-thumb" style={{ left: thumb.left, width: thumb.width }} aria-hidden="true" />}
      {PROJECT_VIEWS.map((item, index) => (
        <button
          key={item.view}
          role="tab"
          aria-selected={index === activeIndex}
          className={`view-slider-item${index === activeIndex ? " active" : ""}`}
          ref={(node) => { itemRefs.current[index] = node; }}
          onClick={() => onChange(item.view)}
        >
          {item.icon}<span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
