import type { HardwareHarnessEventName } from "@hardwareharness/contracts/desktop";

export type DesktopEventListener = (payload: unknown) => void;

export class DesktopEventHub {
  private readonly listeners = new Map<HardwareHarnessEventName, Set<DesktopEventListener>>();

  publish(event: HardwareHarnessEventName, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  subscribe(event: HardwareHarnessEventName, listener: DesktopEventListener): () => void {
    const listeners = this.listeners.get(event) ?? new Set<DesktopEventListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(event);
    };
  }
}
