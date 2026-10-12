import { useEffect, useState } from "react";
import type { ControlWidget } from "@teststand/contracts/monitor";

/** Drag payload of a control from the component sidebar: the widget kind. */
export const CONTROL_MIME = "application/x-teststand-control";

type Request = { panelId: string; widget: ControlWidget };

let pending: Request | undefined;
const listeners = new Set<() => void>();

/**
 * Asks control panel `panelId` to open its "添加控件" dialog for `widget`. The panel may not exist
 * yet (it is being created for the drop): the request waits until it mounts.
 */
export function requestControl(panelId: string, widget: ControlWidget): void {
  pending = { panelId, widget };
  for (const listener of listeners) listener();
}

/** The widget a request asks this control panel to add, once; cleared with `done`. */
export function useControlRequest(panelId: string): [ControlWidget | undefined, () => void] {
  const [widget, setWidget] = useState<ControlWidget>();
  useEffect(() => {
    const take = () => {
      if (pending?.panelId !== panelId) return;
      setWidget(pending.widget);
      pending = undefined;
    };
    take();
    listeners.add(take);
    return () => { listeners.delete(take); };
  }, [panelId]);
  return [widget, () => setWidget(undefined)];
}

/** A fresh id for a control panel made for a dropped or clicked control. */
export function newControlPanelId(): string {
  return `control-${Date.now().toString(36)}`;
}
