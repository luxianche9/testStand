import { randomUUID } from "node:crypto";
import type {
  PinPair,
  PortPosition,
  PortSide,
  ProjectCanvasNode,
  ProjectWiringConnection,
  RequestWiringTaskInput,
  WiringTask,
  WiringTaskStatus
} from "@testforge/contracts/wiring";
import type { Hardware, HardwarePort } from "@testforge/contracts/devices";
import type { ProjectDocument } from "@testforge/contracts/projects";
import type { ProjectWiring } from "@testforge/contracts/wiring";

export interface WiringProjectPort {
  wiring(): ProjectWiring;
  document(): ProjectDocument;
  updateWiring(wiring: ProjectWiring): ProjectDocument;
}

export interface WiringHardwareCatalogPort {
  getHardware(hardwareId: string): Hardware;
  resolvePort(portRef: string): { hardware: Hardware; port: HardwarePort };
  validatePins(portA: string, portB: string, pins: PinPair[]): void;
  warningsForPorts(portA: string, portB: string): string[];
}

/**
 * Wiring is tracked per cable, not per wire: one todo covers one port-to-port connection and every
 * pin pair inside it, so an Agent asks for a 40-way harness once instead of forty times and the
 * operator gets one instruction to carry out.
 *
 * Todos live only in memory for the current session — they are not part of the project file.
 */
export class ProjectWiringService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly tasks = new Map<string, WiringTask>();
  private notifier?: (task: WiringTask) => void;
  private projectNotifier?: () => void;

  constructor(readonly projects: WiringProjectPort, readonly catalog: WiringHardwareCatalogPort) {}

  setNotifier(notifier: (task: WiringTask) => void): void { this.notifier = notifier; }
  /** Fired after a confirmed wiring task mutates the in-memory project document. */
  setProjectNotifier(notifier: () => void): void { this.projectNotifier = notifier; }

  async initialize(): Promise<void> {
    /* session-scoped storage starts empty; nothing to recover across restarts */
  }

  /** Drop every wiring todo when the operator switches project files. */
  clearSession(): void {
    this.tasks.clear();
  }

  /**
   * Add one locally registered managed device to the documentary canvas. This deliberately has no
   * connection input and reconstructs only `nodes`, so an Agent cannot use it to author, remove or
   * rewrite a representation of the real physical wiring.
   */
  async addManagedHardwareToCanvas(hardwareId: string): Promise<{ added: boolean; node: ProjectCanvasNode; dirty: boolean }> {
    return await this.withLock("canvas:nodes", async () => {
      const id = hardwareId.trim();
      if (!id) throw Object.assign(new Error("hardwareId is required"), { category: "invalid_argument" });
      const hardware = this.catalog.getHardware(id);
      if (hardware.kind !== "managed") {
        throw Object.assign(new Error(`Only managed hardware can be added by an Agent: ${id}`), { category: "permission_denied" });
      }
      const wiring = this.projects.wiring();
      const existing = wiring.nodes.find((item) => item.hardwareId === id);
      if (existing) return { added: false, node: existing, dirty: this.projects.document().dirty };

      const index = wiring.nodes.length;
      const node: ProjectCanvasNode = {
        hardwareId: id,
        x: 80 + (index % 3) * 330,
        y: 80 + Math.floor(index / 3) * 240,
        width: 220,
        height: 168,
        showImage: true,
        portPositions: defaultPortPositions(hardware.ports.map((port) => port.portId))
      };
      const document = this.projects.updateWiring({
        nodes: [...wiring.nodes, node],
        // Connections describe real cables. This operation is intentionally incapable of changing them.
        connections: wiring.connections
      });
      this.projectNotifier?.();
      return { added: true, node, dirty: document.dirty };
    });
  }

  async requestTask(input: RequestWiringTaskInput): Promise<WiringTask> {
    const [portA, portB, pins] = canonicalPorts(input.portA, input.portB, input.pins ?? []);
    this.catalog.validatePins(portA, portB, pins);
    const hardwareIds = [...new Set([this.catalog.resolvePort(portA).hardware.hardwareId, this.catalog.resolvePort(portB).hardware.hardwareId])].sort(codePointCompare);
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 30 * 60_000, 1_000), 24 * 60 * 60_000);
    const now = Date.now();
    for (const existing of this.tasks.values()) {
      if (!["pending", "in_progress"].includes(existing.status)) continue;
      if (existing.portA === portA && existing.portB === portB) {
        throw Object.assign(new Error("A pending wiring task already exists for this port pair"), { category: "conflict" });
      }
    }
    const task: WiringTask = {
      wiringTaskId: randomUUID(), action: input.action, portA, portB, pins, hardwareIds, status: "pending",
      requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + timeoutMs).toISOString(),
      warnings: this.catalog.warningsForPorts(portA, portB), ...(input.requestedBy ? { operatorName: input.requestedBy } : {})
    };
    this.tasks.set(task.wiringTaskId, task);
    this.emit(task);
    return structuredClone(task);
  }

  async startTask(wiringTaskId: string, operatorName = "operator"): Promise<WiringTask> {
    return await this.withLock(wiringTaskId, async () => {
      const task = this.getTask(wiringTaskId);
      this.applyLazyTimeout(task);
      if (task.status !== "pending") throw Object.assign(new Error(`Wiring task is ${task.status}, not pending`), { category: "conflict" });
      const started: WiringTask = {
        ...task, status: "in_progress", startedAt: new Date().toISOString(), operatorName: operatorName.trim() || "operator"
      };
      this.save(started);
      this.emit(started);
      return structuredClone(started);
    });
  }

  async completeTask(wiringTaskId: string, outcome: "confirmed" | "rejected", message?: string): Promise<WiringTask> {
    return await this.withLock(wiringTaskId, async () => {
      const task = this.getTask(wiringTaskId);
      if (task.status !== "in_progress") throw Object.assign(new Error("Wiring task is not in progress"), { category: "conflict" });
      if (outcome === "confirmed") {
        try { this.applyConfirmedWiring(task); }
        catch (error) { return await this.finish(task, "failed", `Failed to update wiring: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return await this.finish(task, outcome, message);
    });
  }

  async cancelTask(wiringTaskId: string, message?: string): Promise<WiringTask> {
    return await this.withLock(wiringTaskId, async () => {
      const task = this.getTask(wiringTaskId);
      this.applyLazyTimeout(task);
      if (isTerminal(task.status)) return structuredClone(task);
      return await this.finish(task, "cancelled", message);
    });
  }

  getTask(wiringTaskId: string): WiringTask {
    const task = this.tasks.get(wiringTaskId);
    if (!task) throw new Error(`Unknown wiringTaskId: ${wiringTaskId}`);
    this.applyLazyTimeout(task);
    return structuredClone(task);
  }

  listTasks(input: { status?: WiringTaskStatus; limit?: number } = {}): WiringTask[] {
    this.expirePendingTasks();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const items = [...this.tasks.values()]
      .filter((task) => input.status === undefined || task.status === input.status)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
      .slice(0, limit);
    return items.map((task) => structuredClone(task));
  }

  async close(): Promise<void> {
    const tasks = this.listTasks({ status: "in_progress", limit: 500 });
    await Promise.allSettled(tasks.map((task) => this.cancelTask(task.wiringTaskId, "Application shutdown")));
  }

  private applyConfirmedWiring(task: WiringTask): void {
    const wiring = this.projects.wiring();
    const connectionIndex = wiring.connections.findIndex((item) => samePortPair(item, task));
    if (task.action === "connect") {
      const connection: ProjectWiringConnection = {
        connectionId: connectionIndex >= 0 ? wiring.connections[connectionIndex]!.connectionId : randomUUID(),
        portA: task.portA, portB: task.portB, pins: task.pins,
        confirmedAt: new Date().toISOString(), confirmedBy: task.operatorName ?? "operator"
      };
      if (connectionIndex >= 0) wiring.connections[connectionIndex] = connection;
      else wiring.connections.push(connection);
    } else if (connectionIndex >= 0) {
      wiring.connections.splice(connectionIndex, 1);
    }
    this.projects.updateWiring(wiring);
    this.projectNotifier?.();
  }

  private async finish(task: WiringTask, status: Extract<WiringTaskStatus, "confirmed" | "rejected" | "cancelled" | "timed_out" | "failed">, message?: string): Promise<WiringTask> {
    const finished: WiringTask = {
      ...task, status, completedAt: new Date().toISOString(),
      ...(message ? { message } : {})
    };
    this.save(finished);
    this.emit(finished);
    return structuredClone(finished);
  }

  private applyLazyTimeout(task: WiringTask): void {
    if (task.status !== "pending" || Date.parse(task.expiresAt) > Date.now()) return;
    const expired: WiringTask = { ...task, status: "timed_out", completedAt: new Date().toISOString(), message: "Wiring task expired before processing started" };
    this.save(expired);
    Object.assign(task, expired);
    this.emit(expired);
  }

  private expirePendingTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.status === "pending") this.applyLazyTimeout(task);
    }
  }

  private save(task: WiringTask): void {
    this.tasks.set(task.wiringTaskId, task);
  }

  private emit(task: WiringTask): void { this.notifier?.(structuredClone(task)); }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous.catch(() => undefined);
    try { return await action(); }
    finally { release(); if (this.locks.get(key) === tail) this.locks.delete(key); }
  }
}

/**
 * A cable has no direction, so `A`/`B` are sorted to give one task and one connection per physical
 * pair regardless of which end the caller named first. Pin pairs are swapped along with the ports
 * so each side keeps pointing at the port it belongs to.
 */
function canonicalPorts(left: string, right: string, pins: PinPair[]): [string, string, PinPair[]] {
  const a = left.trim();
  const b = right.trim();
  if (!a || !b || a === b) throw new Error("Two different port references are required");
  return codePointCompare(a, b) <= 0
    ? [a, b, pins.map((pin) => ({ a: pin.a, b: pin.b }))]
    : [b, a, pins.map((pin) => ({ a: pin.b, b: pin.a }))];
}

/** Both are already canonical, so a plain comparison identifies the same physical cable. */
function samePortPair(connection: ProjectWiringConnection, task: WiringTask): boolean {
  return connection.portA === task.portA && connection.portB === task.portB;
}

function defaultPortPositions(portIds: string[]): Record<string, PortPosition> {
  if (portIds.length === 0) return {};
  if (portIds.length === 1) return { [portIds[0]!]: { side: "right", offset: 0.5 } };
  if (portIds.length === 2) return {
    [portIds[0]!]: { side: "left", offset: 0.5 },
    [portIds[1]!]: { side: "right", offset: 0.5 }
  };
  const sides: PortSide[] = ["top", "right", "bottom", "left"];
  const bySide = new Map<PortSide, string[]>();
  for (const side of sides) bySide.set(side, []);
  portIds.forEach((portId, index) => bySide.get(sides[index % sides.length]!)!.push(portId));
  const positions: Record<string, PortPosition> = {};
  for (const side of sides) {
    const ids = bySide.get(side)!;
    ids.forEach((portId, index) => { positions[portId] = { side, offset: (index + 1) / (ids.length + 1) }; });
  }
  return positions;
}

function codePointCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function isTerminal(status: WiringTaskStatus): boolean { return !["pending", "in_progress"].includes(status); }
