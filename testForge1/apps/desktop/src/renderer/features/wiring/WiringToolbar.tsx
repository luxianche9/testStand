export type WiringView = "canvas" | "list";

export function WiringViewSwitch({ view, onChange }: { view: WiringView; onChange: (view: WiringView) => void }) {
  return <div className="canvas-view-switch" role="group" aria-label="接线视图">
    <button type="button" className={view === "canvas" ? "active" : ""} onClick={() => onChange("canvas")}>画布</button>
    <button type="button" className={view === "list" ? "active" : ""} onClick={() => onChange("list")}>列表</button>
  </div>;
}
