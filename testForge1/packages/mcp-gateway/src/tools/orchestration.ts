import { testTaskSchema } from "@testforge/contracts/orchestration";
import { z } from "zod";
import { defineTool, type GatewayToolDefinition } from "./definition.js";
import { UPDATE_TEST_TASK_INPUT_SCHEMA } from "./workflow-schema.js";

const runId = z.object({ runId: z.string().min(1) }).strict();

export const ORCHESTRATION_TOOLS: GatewayToolDefinition[] = [
  defineTool({
    name: "get_test_task", description: "Get the structured test task in the open project.", capability: "orchestration.read", schema: z.object({}).strict(),
    annotations: { readOnlyHint: true }, handler: (application, context) => application.orchestration.getTask(context)
  }),
  defineTool({
    name: "update_test_task", description: "Validate and replace the open project's structured test task.", capability: "orchestration.manage",
    schema: z.object({ task: testTaskSchema }).strict(), inputSchema: UPDATE_TEST_TASK_INPUT_SCHEMA,
    handler: (application, context, input) => {
      const result = application.orchestration.updateTask(context, input.task);
      return { task: result.task, dirty: result.dirty };
    }
  }),
  defineTool({
    name: "start_test_run", description: "Start the open project's test task.", capability: "orchestration.run",
    schema: z.object({ inputs: z.record(z.unknown()).default({}) }).strict(), annotations: { destructiveHint: true },
    handler: (application, context, input) => application.orchestration.startRun(context, { inputs: input.inputs })
  }),
  defineTool({
    name: "cancel_test_run", description: "Cancel a running test.", capability: "orchestration.run", schema: runId,
    annotations: { destructiveHint: true }, handler: (application, context, input) => application.orchestration.cancelRun(context, input.runId)
  }),
  defineTool({
    name: "get_test_run", description: "Get a test run with paged node results and incremental events.", capability: "orchestration.read",
    schema: z.object({ runId: z.string().min(1), sinceEventId: z.number().int().min(0).default(0), nodeOffset: z.number().int().min(0).default(0), nodeLimit: z.number().int().min(1).max(1000).default(200) }).strict(),
    annotations: { readOnlyHint: true }, handler: (application, context, input) => application.orchestration.getRun(context, input.runId, input.sinceEventId, input.nodeOffset, input.nodeLimit)
  })
];
