import { randomUUID } from "node:crypto";
import type { RequestContext } from "@testforge/contracts/agents";
import { appError } from "@testforge/contracts/errors";
import {
  requestHardwareOccupancyInputSchema,
  type HardwareOccupancyRequest,
  type HardwareOccupancyRequestStatus,
  type HardwareOccupancyStatus,
  type RequestHardwareOccupancyInput
} from "@testforge/contracts/occupancy";
import type { DeviceService } from "@testforge/devices";
import type { Authorizer } from "./authorization.js";
import type { ExecutionCoordinator } from "./execution-coordinator.js";

export class HardwareOccupancyApplication {
  private readonly requests = new Map<string, HardwareOccupancyRequest>();
  private notifier?: (request: HardwareOccupancyRequest) => void;

  constructor(
    private readonly authorizer: Authorizer,
    private readonly devices: DeviceService,
    private readonly execution: ExecutionCoordinator
  ) {}

  setNotifier(notifier: (request: HardwareOccupancyRequest) => void): void { this.notifier = notifier; }

  list(context: RequestContext): HardwareOccupancyStatus[] {
    this.authorizer.authorize(context, "hardware.readOccupancy");
    return this.devices.occupancy.list();
  }

  async refresh(context: RequestContext): Promise<HardwareOccupancyStatus[]> {
    this.authorizer.authorize(context, "hardware.readOccupancy");
    return await this.devices.occupancy.refreshAll();
  }

  async acquire(context: RequestContext, hardwareId: string): Promise<HardwareOccupancyStatus> {
    this.authorizer.authorize(context, "hardware.manageOccupancy");
    return await this.devices.occupancy.acquire(hardwareId);
  }

  async release(context: RequestContext, hardwareId: string): Promise<HardwareOccupancyStatus> {
    this.authorizer.authorize(context, "hardware.manageOccupancy");
    if (this.execution.isHardwareBusy(hardwareId)) {
      throw appError("conflict", `Hardware ${hardwareId} is currently executing; stop the manual call or Run before releasing it`);
    }
    return await this.devices.occupancy.release(hardwareId);
  }

  request(context: RequestContext, raw: RequestHardwareOccupancyInput): HardwareOccupancyRequest {
    this.authorizer.authorize(context, "hardware.requestOccupancy");
    const input = requestHardwareOccupancyInputSchema.parse(raw);
    const hardwareIds = [...new Set(input.hardwareIds)].sort(codePointCompare);
    const managed = new Set(this.devices.listServers().filter((server) => server.enabled).map((server) => server.hardwareId));
    const unknown = hardwareIds.filter((hardwareId) => !managed.has(hardwareId));
    if (unknown.length) throw appError("invalid_argument", `Unknown managed hardware: ${unknown.join(", ")}`);
    const requestedAt = new Date().toISOString();
    const request: HardwareOccupancyRequest = {
      occupancyRequestId: randomUUID(),
      hardwareIds,
      status: "pending",
      requestedAt,
      expiresAt: new Date(Date.now() + input.timeoutMs).toISOString(),
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      requestedBy: input.requestedBy ?? (context.actor === "agent" ? "agent" : context.actor)
    };
    this.save(request);
    return structuredClone(request);
  }

  getRequest(context: RequestContext, requestId: string): HardwareOccupancyRequest {
    this.authorizer.authorize(context, "hardware.readOccupancy");
    const request = this.requireRequest(requestId);
    this.expire(request);
    return structuredClone(request);
  }

  listRequests(context: RequestContext, input: { status?: HardwareOccupancyRequestStatus; limit?: number } = {}): HardwareOccupancyRequest[] {
    this.authorizer.authorize(context, "hardware.readOccupancy");
    for (const request of this.requests.values()) this.expire(request);
    return [...this.requests.values()]
      .filter((request) => input.status === undefined || request.status === input.status)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
      .slice(0, input.limit ?? 200)
      .map((request) => structuredClone(request));
  }

  async acquireRequest(context: RequestContext, requestId: string): Promise<HardwareOccupancyRequest> {
    this.authorizer.authorize(context, "hardware.manageOccupancy");
    const request = this.requirePending(requestId);
    const alreadyHeld = new Set(request.hardwareIds.filter((hardwareId) => this.devices.occupancy.isHeld(hardwareId)));
    const newlyHeld: string[] = [];
    try {
      for (const hardwareId of request.hardwareIds) {
        if (alreadyHeld.has(hardwareId)) continue;
        await this.devices.occupancy.acquire(hardwareId);
        newlyHeld.push(hardwareId);
      }
    } catch (error) {
      await Promise.allSettled(newlyHeld.map((hardwareId) => this.devices.occupancy.release(hardwareId)));
      const pending: HardwareOccupancyRequest = { ...request, message: `Occupancy attempt failed: ${error instanceof Error ? error.message : String(error)}` };
      this.save(pending);
      throw appError("conflict", pending.message!, { request: pending });
    }
    return this.finish(request, "confirmed", "All requested hardware is occupied by this TestForge session");
  }

  rejectRequest(context: RequestContext, requestId: string, message?: string): HardwareOccupancyRequest {
    this.authorizer.authorize(context, "hardware.manageOccupancy");
    return this.finish(this.requirePending(requestId), "rejected", message);
  }

  cancelRequest(context: RequestContext, requestId: string, message?: string): HardwareOccupancyRequest {
    this.authorizer.authorize(context, "hardware.requestOccupancy");
    const request = this.requireRequest(requestId);
    if (isTerminal(request.status)) return structuredClone(request);
    return this.finish(request, "cancelled", message);
  }

  reconcile(statuses: HardwareOccupancyStatus[]): void {
    const held = new Set(statuses.filter((status) => status.state === "occupied_by_self").map((status) => status.hardwareId));
    for (const request of this.requests.values()) {
      this.expire(request);
      if (request.status === "pending" && request.hardwareIds.every((hardwareId) => held.has(hardwareId))) {
        this.finish(request, "confirmed", "All requested hardware is occupied by this TestForge session");
      }
    }
  }

  private requireRequest(requestId: string): HardwareOccupancyRequest {
    const request = this.requests.get(requestId);
    if (!request) throw appError("not_found", `Unknown occupancy request: ${requestId}`);
    return request;
  }

  private requirePending(requestId: string): HardwareOccupancyRequest {
    const request = this.requireRequest(requestId);
    this.expire(request);
    if (request.status !== "pending") throw appError("conflict", `Occupancy request is ${request.status}, not pending`);
    return request;
  }

  private expire(request: HardwareOccupancyRequest): void {
    if (request.status !== "pending" || Date.parse(request.expiresAt) > Date.now()) return;
    this.finish(request, "timed_out", "Occupancy request expired before it was accepted");
  }

  private finish(request: HardwareOccupancyRequest, status: Exclude<HardwareOccupancyRequestStatus, "pending">, message?: string): HardwareOccupancyRequest {
    const finished: HardwareOccupancyRequest = {
      ...request,
      status,
      completedAt: new Date().toISOString(),
      ...(message ? { message } : {})
    };
    this.save(finished);
    return structuredClone(finished);
  }

  private save(request: HardwareOccupancyRequest): void {
    this.requests.set(request.occupancyRequestId, request);
    this.notifier?.(structuredClone(request));
  }
}

function isTerminal(status: HardwareOccupancyRequestStatus): boolean { return status !== "pending"; }
function codePointCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
