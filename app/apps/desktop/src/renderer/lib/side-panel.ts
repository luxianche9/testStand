/** Panels of the bench's left sidebar, switched from the activity bar. */
export type SidePanel = "devices" | "testing" | "history" | "log";

export const SIDE_PANEL_LABELS: Record<SidePanel, string> = {
  devices: "设备",
  testing: "测试",
  history: "运行记录",
  log: "接线日志"
};

const OPEN_PANEL = "teststand:open-panel";

/** Asks the shell to show a sidebar panel (`planId` also opens that 功能测试项 in the test panel). */
export function openSidePanel(panel: SidePanel, planId?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_PANEL, { detail: { panel, planId } }));
}

export function onSidePanelRequested(listener: (panel: SidePanel, planId?: string) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ panel?: SidePanel; planId?: string }>).detail;
    if (detail?.panel) listener(detail.panel, detail.planId);
  };
  window.addEventListener(OPEN_PANEL, handler);
  return () => window.removeEventListener(OPEN_PANEL, handler);
}
