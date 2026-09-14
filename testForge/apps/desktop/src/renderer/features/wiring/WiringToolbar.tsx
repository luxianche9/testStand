import { cn } from "../../shared/ui/cn";

export type WiringView = "canvas" | "list";

export function WiringViewSwitch({ view, onChange }: { view: WiringView; onChange: (view: WiringView) => void }) {
  const itemClass = (active: boolean) => cn(
    "h-[26px] min-w-13 rounded-sm px-2.5 text-xs transition-colors",
    active
      ? "bg-background text-foreground shadow-sm ring-1 ring-border"
      : "text-muted-foreground hover:text-foreground"
  );
  return (
    <div
      role="group"
      aria-label="接线视图"
      className="absolute top-2.5 left-2.5 z-[5] flex items-center gap-0.5 rounded-lg bg-popover p-0.5 shadow-md ring-1 ring-border"
    >
      <button type="button" aria-pressed={view === "canvas"} className={itemClass(view === "canvas")} onClick={() => onChange("canvas")}>画布</button>
      <button type="button" aria-pressed={view === "list"} className={itemClass(view === "list")} onClick={() => onChange("list")}>列表</button>
    </div>
  );
}
