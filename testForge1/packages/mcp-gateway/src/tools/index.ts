import type { GatewayToolDefinition } from "./definition.js";
import { DEVICE_TOOLS } from "./devices.js";
import { HARDWARE_TOOLS } from "./hardware.js";
import { ORCHESTRATION_TOOLS } from "./orchestration.js";
import { WIRING_TOOLS } from "./wiring.js";

export const BUILTIN_TOOL_DEFINITIONS: GatewayToolDefinition[] = [
  ...DEVICE_TOOLS,
  ...HARDWARE_TOOLS,
  ...WIRING_TOOLS,
  ...ORCHESTRATION_TOOLS
];

export type { GatewayToolDefinition } from "./definition.js";
export { UPDATE_TEST_TASK_INPUT_SCHEMA } from "./workflow-schema.js";
