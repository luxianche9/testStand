import type { ReactNode } from "react";
import { CableIcon, CpuIcon, HistoryIcon, ListTreeIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";
import { SIDE_PANEL_LABELS, type SidePanel } from "../lib/side-panel.js";
import { Tooltip, cn } from "../ui";

const PANELS: { panel: SidePanel; icon: ReactNode }[] = [
  { panel: "devices", icon: <CpuIcon /> },
  { panel: "testing", icon: <ListTreeIcon /> },
  { panel: "history", icon: <HistoryIcon /> },
  { panel: "log", icon: <CableIcon /> }
];

/**
 * The column of icons at the window's left edge: each switches the bench's sidebar to a panel (a
 * second click on the shown one folds the sidebar away); settings and the theme sit at its foot.
 */
export function ActivityBar({ panel, inProject, settingsOpen, theme, onPanel, onSettings, onToggleTheme }: {
  /** The panel shown, or none while the sidebar is folded away. */
  panel: SidePanel | undefined;
  inProject: boolean;
  settingsOpen: boolean;
  theme: "light" | "dark";
  onPanel: (panel: SidePanel) => void;
  onSettings: () => void;
  onToggleTheme: () => void;
}) {
  return (
    <nav
      aria-label="活动栏"
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface-1 py-1.5"
    >
      {inProject && PANELS.map((item) => (
        <BarButton
          key={item.panel}
          label={SIDE_PANEL_LABELS[item.panel]}
          active={!settingsOpen && panel === item.panel}
          onClick={() => onPanel(item.panel)}
        >
          {item.icon}
        </BarButton>
      ))}
      <span className="flex-1" />
      <BarButton label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} onClick={onToggleTheme}>
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </BarButton>
      <BarButton label="设置" active={settingsOpen} onClick={onSettings}><SettingsIcon /></BarButton>
    </nav>
  );
}

function BarButton({ label, active, onClick, children }: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active ?? undefined}
        onClick={onClick}
        className={cn(
          "relative grid size-9 place-items-center rounded-md text-fg-3 transition-colors duration-120",
          "hover:bg-surface-2 hover:text-fg [&_svg]:size-[18px]",
          active && "text-fg before:absolute before:inset-y-1.5 before:-left-1 before:w-0.5 before:rounded-full",
          active && "before:bg-signal"
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}
