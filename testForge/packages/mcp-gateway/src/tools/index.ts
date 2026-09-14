import type { GatewayToolDefinition } from "./definition.js";
import { DEVICE_TOOLS } from "./devices.js";
import { HARDWARE_TOOLS } from "./hardware.js";
import { ORCHESTRATION_TOOLS } from "./orchestration.js";
import { OCCUPANCY_TOOLS } from "./occupancy.js";
import { WIRING_TOOLS } from "./wiring.js";
import { PROJECT_TOOLS } from "./projects.js";

export const BUILTIN_TOOL_DEFINITIONS: GatewayToolDefinition[] = [
  ...PROJECT_TOOLS,
  ...DEVICE_TOOLS,
  ...HARDWARE_TOOLS,
  ...OCCUPANCY_TOOLS,
  ...WIRING_TOOLS,
  ...ORCHESTRATION_TOOLS
];

export type { GatewayToolDefinition } from "./definition.js";
export { UPDATE_TEST_TASK_INPUT_SCHEMA } from "./workflow-schema.js";
