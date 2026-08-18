import { requestHardwareOccupancyInputSchema } from "@testforge/contracts/occupancy";
import { z } from "zod";
import { defineTool, type GatewayToolDefinition } from "./definition.js";

const requestId = z.object({ occupancyRequestId: z.string().min(1) }).strict();

export const OCCUPANCY_TOOLS: GatewayToolDefinition[] = [
  defineTool({
    name: "request_hardware_occupancy",
    description: "Ask a human to occupy one or more managed hardware devices. This does not acquire a lease by itself.",
    capability: "hardware.requestOccupancy",
    schema: requestHardwareOccupancyInputSchema,
    handler: (application, context, input) => application.occupancy.request(context, input)
  }),
  defineTool({
    name: "cancel_hardware_occupancy_request",
    description: "Cancel a pending human hardware occupancy request.",
    capability: "hardware.requestOccupancy",
    schema: z.object({ occupancyRequestId: z.string().min(1), message: z.string().optional() }).strict(),
    handler: (application, context, input) => application.occupancy.cancelRequest(context, input.occupancyRequestId, input.message)
  }),
  defineTool({
    name: "get_hardware_occupancy_request",
    description: "Get one hardware occupancy request.",
    capability: "hardware.readOccupancy",
    schema: requestId,
    annotations: { readOnlyHint: true },
    handler: (application, context, input) => application.occupancy.getRequest(context, input.occupancyRequestId)
  }),
  defineTool({
    name: "list_hardware_occupancy_requests",
    description: "List recent hardware occupancy requests.",
    capability: "hardware.readOccupancy",
    schema: z.object({
      status: z.enum(["pending", "confirmed", "rejected", "cancelled", "timed_out", "failed"]).optional(),
      limit: z.number().int().min(1).max(500).default(200)
    }).strict(),
    annotations: { readOnlyHint: true },
    handler: (application, context, input) => application.occupancy.listRequests(context, {
      limit: input.limit,
      ...(input.status === undefined ? {} : { status: input.status })
    })
  })
];
