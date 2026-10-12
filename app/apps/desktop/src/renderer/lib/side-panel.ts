/** Panels of the bench's left sidebar, switched from the activity bar. */
export type SidePanel = "devices" | "components" | "log" | "testing" | "history";

/** The panels in activity-bar order, top to bottom. */
export const SIDE_PANELS: readonly SidePanel[] = ["devices", "components", "log", "testing", "history"];

export const SIDE_PANEL_LABELS: Record<SidePanel, string> = {
  devices: "设备管理",
  components: "组件",
  log: "接线日志",
  testing: "测试编排",
  history: "运行历史"
};

const OPEN_PANEL = "teststand:open-panel";

/** Asks the shell to show a sidebar panel. */
export function openSidePanel(panel: SidePanel) {
  window.dispatchEvent(new CustomEvent(OPEN_PANEL, { detail: { panel } }));
}

export function onSidePanelRequested(listener: (panel: SidePanel) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ panel?: SidePanel }>).detail;
    if (detail?.panel) listener(detail.panel);
  };
  window.addEventListener(OPEN_PANEL, handler);
  return () => window.removeEventListener(OPEN_PANEL, handler);
}
