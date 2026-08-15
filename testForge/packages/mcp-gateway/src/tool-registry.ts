import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RequestContext } from "@testforge/contracts/agents";
import type { ToolCatalogItem } from "@testforge/contracts/devices";
import { appError } from "@testforge/contracts/errors";
import type { TestForgeApplication } from "@testforge/application";
import { BUILTIN_TOOL_DEFINITIONS, type GatewayToolDefinition } from "./tools/index.js";

export class ToolRegistry {
  private readonly builtinByName: Map<string, GatewayToolDefinition>;

  constructor(
    private readonly application: TestForgeApplication,
    definitions: GatewayToolDefinition[] = BUILTIN_TOOL_DEFINITIONS
  ) {
    this.builtinByName = uniqueDefinitions(definitions);
  }

  listBuiltin(context: RequestContext): Tool[] {
    return [...this.builtinByName.values()]
      .filter((definition) => this.application.authorizer.isAllowed(context, definition.capability))
      .map((definition) => structuredClone(definition.tool));
  }

  list(context: RequestContext): Tool[] {
    const builtin = this.listBuiltin(context);
    const remote = this.application.authorizer.isAllowed(context, "hardware.executeTools")
      ? this.application.devices.listTools(context).map(aggregatedTool)
      : [];
    assertUniqueToolNames([...builtin, ...remote]);
    return [...builtin, ...remote];
  }

  async invoke(context: RequestContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const builtin = this.builtinByName.get(name);
    if (builtin) {
      this.application.authorizer.authorize(context, builtin.capability);
      return await builtin.execute(this.application, context, builtin.parse(args));
    }
    this.application.authorizer.authorize(context, "hardware.executeTools");
    const remote = this.application.devices.listTools(context).find((tool) => tool.externalName === name);
    if (!remote) throw appError("not_found", `Unknown MCP tool: ${name}`);
    return { ok: true, data: await this.application.devices.callTool(context, name, args) };
  }
}

function uniqueDefinitions(definitions: GatewayToolDefinition[]): Map<string, GatewayToolDefinition> {
  const byName = new Map<string, GatewayToolDefinition>();
  for (const definition of definitions) {
    if (byName.has(definition.tool.name)) throw new Error(`Duplicate builtin MCP tool name: ${definition.tool.name}`);
    byName.set(definition.tool.name, definition);
  }
  return byName;
}

function aggregatedTool(tool: ToolCatalogItem): Tool {
  return {
    name: tool.externalName,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema) as Tool["inputSchema"]
  };
}

function assertUniqueToolNames(tools: Tool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw appError("conflict", `Duplicate MCP tool name: ${tool.name}`);
    names.add(tool.name);
  }
}
