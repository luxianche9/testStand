import { useEffect, useRef } from "react";
import type { ToolCatalogItem } from "@teststand/contracts/devices";
import { Badge, cn } from "../../ui";
import { actionKind, actionName } from "./device-actions.js";

export type ControlMenuState = { hardwareId: string; x: number; y: number };

/** The actions a device on the canvas offers, opened from its 控制 button. Picking one opens
 *  its parameter dialog; Escape or a click elsewhere closes the menu. */
export function DeviceControlMenu({ menu, label, actions, onPick, onClose }: {
  menu: ControlMenuState;
  label: string;
  actions: ToolCatalogItem[];
  onPick: (action: ToolCatalogItem) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);
  const width = 248;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${label} 的控制动作`}
      className={cn(
        "fixed z-30 grid max-h-[60vh] animate-fade-in gap-px overflow-y-auto rounded-md border border-line-strong",
        "bg-surface-2 p-1 shadow-overlay"
      )}
      style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - width - 8)), top: menu.y, width }}
    >
      <div className="px-2 py-1 text-2xs text-fg-3">{label}</div>
      {actions.length === 0 && <p className="px-2 py-1.5 text-xs text-fg-3">该设备没有可执行的动作。</p>}
      {actions.map((action) => {
        const kind = actionKind(action);
        return (
          <button
            key={action.externalName}
            type="button"
            role="menuitem"
            title={action.description}
            className={cn(
              "flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-sm text-fg outline-none",
              "transition-colors duration-120 hover:bg-surface-3 focus-visible:bg-surface-3"
            )}
            onClick={() => onPick(action)}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{actionName(action, actions)}</span>
            <Badge tone={kind.tone}>{kind.label}</Badge>
          </button>
        );
      })}
    </div>
  );
}
