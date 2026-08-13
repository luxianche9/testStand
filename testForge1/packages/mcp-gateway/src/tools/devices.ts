import { mcpServerSchema, remoteComputerSchema } from "@testforge/contracts/devices";
import { z } from "zod";
import { defineTool, type GatewayToolDefinition } from "./definition.js";

const empty = z.object({}).strict();
const computerId = z.object({ computerId: z.string().min(1) }).strict();
const serverId = z.object({ serverId: z.string().min(1) }).strict();
const saveComputer = z.object({
  computer: remoteComputerSchema,
  sshPassword: z.string().optional(),
  sshPrivateKey: z.string().optional()
}).strict().superRefine((input, context) => {
  if (input.sshPassword && input.sshPrivateKey) context.addIssue({ code: "custom", message: "Provide only one of sshPassword or sshPrivateKey" });
});
const saveServer = mcpServerSchema.extend({ mcpToken: z.string().min(1).optional() }).strict();

export const DEVICE_TOOLS: GatewayToolDefinition[] = [
  defineTool({
    name: "list_remote_computers", description: "List configured remote computers without credentials.", capability: "devices.read", schema: empty,
    annotations: { readOnlyHint: true }, handler: (application, context) => application.devices.listComputers(context)
  }),
  defineTool({
    name: "save_remote_computer", description: "Create or update a remote computer and optional SSH credential.", capability: "devices.manageComputers", schema: saveComputer,
    handler: (application, context, input) => application.devices.saveComputer(context, input.computer, sshCredential(input))
  }),
  defineTool({
    name: "remove_remote_computer", description: "Remove a remote computer and its MCP registrations.", capability: "devices.manageComputers", schema: computerId,
    annotations: { destructiveHint: true }, handler: (application, context, input) => application.devices.removeComputer(context, input.computerId)
  }),
  defineTool({
    name: "get_remote_computer_status", description: "Get SSH and hosted MCP service status for one computer.", capability: "devices.read", schema: computerId,
    annotations: { readOnlyHint: true }, handler: (application, context, input) => application.devices.getComputerStatus(context, input.computerId)
  }),
  defineTool({
    name: "ssh_execute", description: "Execute an unrestricted command through SSH.", capability: "devices.ssh",
    schema: z.object({ computerId: z.string().min(1), command: z.string().min(1), timeoutMs: z.number().int().min(1000).max(300000).default(60000) }).strict(),
    annotations: { destructiveHint: true }, handler: (application, context, input) => application.devices.executeSsh(context, input.computerId, input.command, input.timeoutMs)
  }),
  defineTool({
    name: "list_mcp_servers", description: "List registered MCP servers and their current status.", capability: "devices.read", schema: empty,
    annotations: { readOnlyHint: true }, handler: (application, context) => application.devices.listServersWithStatus(context)
  }),
  defineTool({
    name: "register_mcp_server", description: "Create or update a local MCP server registration.", capability: "devices.manageServers", schema: saveServer,
    handler: (application, context, input) => {
      const { mcpToken, ...server } = input;
      return application.devices.saveServer(context, server, mcpToken === undefined ? undefined : { mcpToken });
    }
  }),
  defineTool({
    name: "unregister_mcp_server", description: "Remove a local MCP server registration.", capability: "devices.manageServers", schema: serverId,
    annotations: { destructiveHint: true }, handler: (application, context, input) => application.devices.removeServer(context, input.serverId)
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
    name: "force_stop_remote_mcp_service", description: "Force-stop a remote MCP service without successful safe-stop.", capability: "devices.forceStopServers", schema: serverId,
    annotations: { destructiveHint: true }, handler: (application, context, input) => application.devices.serverAction(context, input.serverId, "force-stop")
  }),
  defineTool({
    name: "read_remote_mcp_logs", description: "Read the tail of one MCP server's logs.", capability: "devices.read",
    schema: z.object({ serverId: z.string().min(1), lines: z.number().int().min(1).max(2000).default(200) }).strict(),
    annotations: { readOnlyHint: true }, handler: (application, context, input) => application.devices.readServerLogs(context, input.serverId, input.lines)
  })
];

function sshCredential(input: z.infer<typeof saveComputer>) {
  if (input.sshPassword) return { ssh: { kind: "password" as const, password: input.sshPassword } };
  if (input.sshPrivateKey) return { ssh: { kind: "privateKey" as const, privateKey: input.sshPrivateKey } };
  return undefined;
}
