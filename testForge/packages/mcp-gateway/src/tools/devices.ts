import { z } from "zod";
import { defineTool, type GatewayToolDefinition } from "./definition.js";

const empty = z.object({}).strict();
const computerId = z.object({ computerId: z.string().min(1) }).strict();
const serverId = z.object({ serverId: z.string().min(1) }).strict();

export const DEVICE_TOOLS: GatewayToolDefinition[] = [
  defineTool({
    name: "list_remote_computers", description: "List configured remote computers without credentials.", capability: "devices.read", schema: empty,
    annotations: { readOnlyHint: true }, handler: (application, context) => application.devices.listComputers(context)
  }),
  defineTool({
    name: "get_remote_computer_status", description: "Get SSH and hosted MCP service status for one computer.", capability: "devices.read", schema: computerId,
    annotations: { readOnlyHint: true }, handler: (application, context, input) => application.devices.getComputerStatus(context, input.computerId)
  }),
  defineTool({
    name: "list_mcp_servers", description: "List registered MCP servers and their current status.", capability: "devices.read", schema: empty,
    annotations: { readOnlyHint: true }, handler: (application, context) => application.devices.listServersWithStatus(context)
  }),
  defineTool({
    name: "get_remote_mcp_service", description: "Query one MCP server's remote process and connection state.", capability: "devices.read", schema: serverId,
    annotations: { readOnlyHint: true }, handler: (application, context, input) => application.devices.refreshServer(context, input.serverId)
  }),
  ...(["start", "stop", "restart"] as const).map((action) => defineTool({
    name: `${action}_remote_mcp_service`, description: `${action} one remote MCP service using its configured safe lifecycle.`, capability: "devices.controlServers", schema: serverId,
    annotations: { destructiveHint: action !== "start" }, handler: (application, context, input) => application.devices.serverAction(context, input.serverId, action)
  })),
  defineTool({
    name: "read_remote_mcp_logs", description: "Read the tail of one MCP server's logs.", capability: "devices.read",
    schema: z.object({ serverId: z.string().min(1), lines: z.number().int().min(1).max(2000).default(200) }).strict(),
    annotations: { readOnlyHint: true }, handler: (application, context, input) => application.devices.readServerLogs(context, input.serverId, input.lines)
  })
];
