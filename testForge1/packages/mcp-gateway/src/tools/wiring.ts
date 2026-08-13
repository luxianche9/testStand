import { pinPairSchema } from "@testforge/contracts/wiring";
import { z } from "zod";
import { defineTool, type GatewayToolDefinition } from "./definition.js";

const taskId = z.object({ wiringTaskId: z.string().min(1) }).strict();

export const WIRING_TOOLS: GatewayToolDefinition[] = [
  defineTool({
    name: "add_managed_hardware_to_canvas", description: "Idempotently add managed hardware to the open project's canvas.", capability: "projects.manage",
    schema: z.object({ hardwareId: z.string().min(1) }).strict(), handler: (application, context, input) => application.wiring.addManagedHardwareToCanvas(context, input.hardwareId)
  }),
  defineTool({
    name: "request_wiring_task", description: "Create a human wiring todo without changing physical wiring.", capability: "wiring.request",
    schema: z.object({
      portA: z.string().min(1), portB: z.string().min(1), pins: z.array(pinPairSchema).default([]), action: z.enum(["connect", "disconnect"]),
      timeoutMs: z.number().int().min(1000).max(86400000).default(1800000)
    }).strict(),
    handler: (application, context, input) => application.wiring.requestTask(context, input)
  }),
  defineTool({
    name: "cancel_wiring_task", description: "Cancel a wiring todo.", capability: "wiring.request",
    schema: z.object({ wiringTaskId: z.string().min(1), message: z.string().optional() }).strict(),
    handler: (application, context, input) => application.wiring.cancelTask(context, input.wiringTaskId, input.message)
  }),
  defineTool({
    name: "get_wiring_task", description: "Get one session wiring todo.", capability: "wiring.read", schema: taskId,
    annotations: { readOnlyHint: true }, handler: (application, context, input) => application.wiring.getTask(context, input.wiringTaskId)
  }),
  defineTool({
    name: "list_wiring_tasks", description: "List recent wiring todos.", capability: "wiring.read",
    schema: z.object({ status: z.enum(["pending", "in_progress", "confirmed", "rejected", "cancelled", "timed_out", "failed"]).optional(), limit: z.number().int().min(1).max(500).default(100) }).strict(),
    annotations: { readOnlyHint: true }, handler: (application, context, input) => application.wiring.listTasks(context, {
      ...(input.status === undefined ? {} : { status: input.status }),
      limit: input.limit
    })
  })
];
