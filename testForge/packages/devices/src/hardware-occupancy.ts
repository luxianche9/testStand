import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { HardwareOccupancyStatus } from "@testforge/contracts/occupancy";
import { appError } from "@testforge/contracts/errors";
import type { DeviceStore } from "./device-store.js";
import type { DeviceTransportRegistry } from "./device-transport.js";

const HEARTBEAT_MS = 5_000;

interface ActiveLease {
  hardwareId: string;
  leaseId: string;
  acquiredAt: string;
  expiresAt: string;
}

interface RemoteOccupancy {
  state?: "unoccupied" | "occupied";
  holderId?: string;
  holderLabel?: string;
  acquiredAt?: string;
  expiresAt?: string;
}

export class HardwareOccupancyManager {
  private readonly holderId = randomUUID();
  private readonly holderLabel = `TestForge@${hostname()}`;
  private readonly active = new Map<string, ActiveLease>();
  private readonly statuses = new Map<string, HardwareOccupancyStatus>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private notifier?: (statuses: HardwareOccupancyStatus[]) => void;
  private lostNotifier?: (hardwareId: string, message: string) => void;

  constructor(private readonly store: DeviceStore, private readonly transports: DeviceTransportRegistry) {}

  setNotifier(notifier: (statuses: HardwareOccupancyStatus[]) => void): void { this.notifier = notifier; }
  setLostNotifier(notifier: (hardwareId: string, message: string) => void): void { this.lostNotifier = notifier; }

  list(): HardwareOccupancyStatus[] {
    const managed = this.store.listServers().map((server) => server.hardwareId);
    return managed.map((hardwareId) => structuredClone(this.statuses.get(hardwareId) ?? { hardwareId, state: "unknown" }));
  }

  isHeld(hardwareId: string): boolean {
    const lease = this.active.get(hardwareId);
    return Boolean(lease && Date.parse(lease.expiresAt) > Date.now());
  }

  requireLease(hardwareId: string): string {
    const lease = this.active.get(hardwareId);
    if (!lease || Date.parse(lease.expiresAt) <= Date.now()) {
      if (lease) this.markLost(hardwareId, "Hardware occupancy lease expired");
      throw appError("occupancy_required", `Hardware ${hardwareId} must be occupied by a human before it can be operated`);
    }
    return lease.leaseId;
  }

  async refresh(hardwareId: string): Promise<HardwareOccupancyStatus> {
    const server = this.serverForHardware(hardwareId);
    try {
      const remote = await this.transports.callInternal(server, "testforge_hardware_occupancy", { hardwareId, action: "status" }) as RemoteOccupancy;
      const status = this.toStatus(hardwareId, remote);
      this.statuses.set(hardwareId, status);
      if (this.active.has(hardwareId) && status.state !== "occupied_by_self") this.markLost(hardwareId, "Remote hardware lease is no longer owned by this TestForge session");
      this.emit();
      return structuredClone(this.statuses.get(hardwareId) ?? status);
    } catch (error) {
      const status: HardwareOccupancyStatus = { hardwareId, state: "unknown", message: String(error) };
      this.statuses.set(hardwareId, status);
      this.emit();
      return structuredClone(status);
    }
  }

  async refreshAll(): Promise<HardwareOccupancyStatus[]> {
    await Promise.allSettled(this.store.listServers().filter((server) => server.enabled).map((server) => this.refresh(server.hardwareId)));
    return this.list();
  }

  async acquire(hardwareId: string): Promise<HardwareOccupancyStatus> {
    if (this.isHeld(hardwareId)) return this.current(hardwareId);
    const server = this.serverForHardware(hardwareId);
    const leaseId = randomUUID();
    const remote = await this.transports.callInternal(server, "testforge_hardware_occupancy", {
      hardwareId, action: "acquire", holderId: this.holderId, holderLabel: this.holderLabel, leaseId
    }) as RemoteOccupancy;
    if (remote.state !== "occupied" || remote.holderId !== this.holderId || !remote.expiresAt) {
      throw appError("conflict", `Hardware ${hardwareId} could not be occupied`, remote);
    }
    const lease: ActiveLease = { hardwareId, leaseId, acquiredAt: remote.acquiredAt ?? new Date().toISOString(), expiresAt: remote.expiresAt };
    this.active.set(hardwareId, lease);
    this.statuses.set(hardwareId, this.toStatus(hardwareId, remote));
    this.ensureTimer();
    this.emit();
    return this.current(hardwareId);
  }

  async release(hardwareId: string): Promise<HardwareOccupancyStatus> {
    const lease = this.active.get(hardwareId);
    if (!lease) return await this.refresh(hardwareId);
    const server = this.serverForHardware(hardwareId);
    const remote = await this.transports.callInternal(server, "testforge_hardware_occupancy", {
      hardwareId, action: "release", holderId: this.holderId, leaseId: lease.leaseId
    }) as RemoteOccupancy;
    this.active.delete(hardwareId);
    this.statuses.set(hardwareId, this.toStatus(hardwareId, remote));
    this.stopTimerIfIdle();
    this.emit();
    return this.current(hardwareId);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const leases = [...this.active.keys()];
    await Promise.allSettled(leases.map((hardwareId) => this.release(hardwareId)));
    this.active.clear();
  }

  private async heartbeat(): Promise<void> {
    for (const lease of [...this.active.values()]) {
      try {
        const server = this.serverForHardware(lease.hardwareId);
        const remote = await this.transports.callInternal(server, "testforge_hardware_occupancy", {
          hardwareId: lease.hardwareId, action: "heartbeat", holderId: this.holderId, leaseId: lease.leaseId
        }) as RemoteOccupancy;
        if (remote.state !== "occupied" || remote.holderId !== this.holderId || !remote.expiresAt) {
          this.markLost(lease.hardwareId, "Hardware occupancy heartbeat was rejected");
          continue;
        }
        lease.expiresAt = remote.expiresAt;
        this.statuses.set(lease.hardwareId, this.toStatus(lease.hardwareId, remote));
        this.emit();
      } catch (error) {
        if (Date.parse(lease.expiresAt) <= Date.now()) this.markLost(lease.hardwareId, `Hardware occupancy heartbeat expired: ${String(error)}`);
      }
    }
  }

  private toStatus(hardwareId: string, remote: RemoteOccupancy): HardwareOccupancyStatus {
    if (remote.state !== "occupied") return { hardwareId, state: "unoccupied" };
    return {
      hardwareId,
      state: remote.holderId === this.holderId ? "occupied_by_self" : "occupied_elsewhere",
      ...(remote.holderLabel ? { holderLabel: remote.holderLabel } : {}),
      ...(remote.acquiredAt ? { acquiredAt: remote.acquiredAt } : {}),
      ...(remote.expiresAt ? { expiresAt: remote.expiresAt } : {})
    };
  }

  private current(hardwareId: string): HardwareOccupancyStatus {
    return structuredClone(this.statuses.get(hardwareId) ?? { hardwareId, state: "unknown" });
  }

  private serverForHardware(hardwareId: string) {
    const server = this.store.listServers().find((item) => item.hardwareId === hardwareId && item.enabled);
    if (!server) throw appError("not_found", `No enabled MCP server is registered for hardware ${hardwareId}`);
    return server;
  }

  private markLost(hardwareId: string, message: string): void {
    if (!this.active.delete(hardwareId)) return;
    this.statuses.set(hardwareId, { hardwareId, state: "unknown", message });
    this.stopTimerIfIdle();
    this.emit();
    this.lostNotifier?.(hardwareId, message);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.heartbeat(); }, HEARTBEAT_MS);
    this.timer.unref?.();
  }

  private stopTimerIfIdle(): void {
    if (this.active.size || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private emit(): void { this.notifier?.(this.list()); }
}
