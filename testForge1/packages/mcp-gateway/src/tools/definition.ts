import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Capability, RequestContext } from "@testforge/contracts/agents";
import type { TestForgeApplication } from "@testforge/application";
import { type ZodType, type ZodTypeDef } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface GatewayToolDefinition {
  readonly tool: Tool;
  readonly capability: Capability;
  parse(input: unknown): unknown;
  execute(application: TestForgeApplication, context: RequestContext, input: unknown): Promise<Record<string, unknown>>;
}

interface ToolOptions<T> {
  name: string;
  description: string;
  capability: Capability;
  schema: ZodType<T, ZodTypeDef, unknown>;
  inputSchema?: Tool["inputSchema"];
  annotations?: Tool["annotations"];
  handler(application: TestForgeApplication, context: RequestContext, input: T): Promise<unknown> | unknown;
}

export function defineTool<T>(options: ToolOptions<T>): GatewayToolDefinition {
  return {
    tool: {
      name: options.name,
      description: options.description,
      inputSchema: options.inputSchema ?? schemaFromZod(options.schema),
      ...(options.annotations ? { annotations: options.annotations } : {})
    },
    capability: options.capability,
    parse: (input) => options.schema.parse(input),
    execute: async (application, context, input) => ({
      ok: true,
      data: await options.handler(application, context, input as T)
    })
  };
}

function schemaFromZod(schema: ZodType<unknown>): Tool["inputSchema"] {
  const json = zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" });
  const { $schema: _schema, definitions: _definitions, ...inputSchema } = json;
  return inputSchema as Tool["inputSchema"];
}
