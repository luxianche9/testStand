import type { RequestContext } from "@testforge/contracts/agents";
import { appError } from "@testforge/contracts/errors";
import { manualToolInvocationInputSchema, type ManualToolInvocationInput, type ManualToolInvocationResult } from "@testforge/contracts/execution";
import type { DeviceCatalogService, DeviceService } from "@testforge/devices";
import type { Authorizer } from "./authorization.js";
import type { ExecutionCoordinator } from "./execution-coordinator.js";

export class ManualControlApplication {
  private readonly active = new Set<{ hardwareId: string; controller: AbortController; completion: Promise<ManualToolInvocationResult> }>();

  constructor(
    private readonly authorizer: Authorizer,
    private readonly devices: DeviceService,
    private readonly catalog: DeviceCatalogService,
    private readonly execution: ExecutionCoordinator
  ) {}

  async invokeTool(context: RequestContext, raw: ManualToolInvocationInput): Promise<ManualToolInvocationResult> {
    this.authorizer.authorize(context, "hardware.executeTools");
    const input = manualToolInvocationInputSchema.parse(raw);
    const hardware = this.catalog.getHardware(input.hardwareId);
    if (hardware.kind !== "managed" || !hardware.serverId) {
      throw appError("invalid_argument", `Hardware ${input.hardwareId} is passive and cannot execute MCP tools`);
    }
    const tool = this.devices.listTools().find((item) => item.externalName === input.toolName);
    if (!tool) throw appError("unavailable", `MCP tool is unavailable: ${input.toolName}`);
    if (tool.serverId !== hardware.serverId) {
      throw appError("invalid_argument", `Tool ${input.toolName} belongs to ${tool.serverId}, not hardware server ${hardware.serverId}`);
    }
    // Hardware-scoped tools need a live device; management tools may still be useful while offline.
    if (tool.kind === "hardware") {
      const availability = this.devices.listAvailability().find((item) => item.hardwareId === input.hardwareId);
      if (!availability || availability.state !== "available") {
        throw appError("unavailable", availability?.message ?? `Hardware ${input.hardwareId} is ${availability?.state ?? "not yet checked"}`);
      }
    }

    const startedAt = new Date().toISOString();
    const started = performance.now();
    const lease = this.execution.acquire({
      state: "manual",
      hardwareId: input.hardwareId,
      toolName: input.toolName,
      startedAt
    });
    const controller = new AbortController();
    let activeCall!: { hardwareId: string; controller: AbortController; completion: Promise<ManualToolInvocationResult> };
    let completion!: Promise<ManualToolInvocationResult>;
    completion = (async () => {
      try {
        const output = await this.devices.callTool(
          input.toolName,
          input.arguments,
          { timeoutMs: input.timeoutMs, signal: controller.signal, metadata: { hardwareId: input.hardwareId } }
        );
        const completedAt = new Date().toISOString();
        return {
          hardwareId: input.hardwareId,
          toolName: input.toolName,
          startedAt,
          completedAt,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
          output
        };
      } finally {
        this.active.delete(activeCall);
        lease.release();
      }
    })();
    activeCall = { hardwareId: input.hardwareId, controller, completion };
    this.active.add(activeCall);
    return await completion;
  }

  async abortHardware(hardwareId: string, message: string): Promise<void> {
    const active = [...this.active].filter((call) => call.hardwareId === hardwareId);
    for (const call of active) call.controller.abort(Object.assign(new Error(message), { name: "AbortError" }));
    await Promise.allSettled(active.map((call) => call.completion));
  }

  async close(): Promise<void> {
    const active = [...this.active];
    for (const call of active) call.controller.abort(Object.assign(new Error("Application shutdown"), { name: "AbortError" }));
    await Promise.allSettled(active.map((call) => call.completion));
  }
}
