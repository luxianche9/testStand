import type { TaskValidationResult, TestTask, WorkflowValidationIssue } from "@testforge/contracts/orchestration";
import { collectTaskSteps, validateTestTask } from "./workflow.js";
import type { OrchestrationCatalogPort, OrchestrationToolPort } from "./orchestration-ports.js";

export class TaskValidator {
  constructor(
    private readonly tools: OrchestrationToolPort,
    private readonly catalog: OrchestrationCatalogPort
  ) {}

  validate(task: TestTask): TaskValidationResult {
    const base = validateTestTask(task);
    const issues = [...base.issues];
    const tools = new Map(this.tools.listTools().map((item) => [item.externalName, item]));
    for (const step of collectTaskSteps(task)) {
      if (step.type !== "tool" || !step.enabled) continue;
      const tool = tools.get(step.toolName);
      if (!tool) issues.push(issue("unknown_tool", `MCP tool is unavailable: ${step.toolName}`, step.stepId));
      else if (tool.kind !== "hardware") issues.push(issue("tool_not_hardware", `Tool step requires a hardware-scoped MCP tool: ${step.toolName}`, step.stepId));
      try {
        const hardware = this.catalog.getHardware(step.hardwareId);
        if (hardware.kind !== "managed") issues.push(issue("passive_tool_target", `Tool step cannot target passive hardware ${step.hardwareId}`, step.stepId));
        else if (tool && hardware.serverId !== tool.serverId) issues.push(issue("tool_hardware_mismatch", `Tool ${step.toolName} belongs to ${tool.serverId}, not hardware server ${hardware.serverId}`, step.stepId));
      } catch { /* unresolved hardware is reported during Run preflight */ }
    }
    return { valid: !issues.some((item) => item.severity === "error"), issues };
  }

  preflight(task: TestTask, canvasHardware: string[], inputs: Record<string, unknown>): WorkflowValidationIssue[] {
    const issues = [...this.validate(task).issues];
    const variables = new Map(task.inputs.map((item) => [item.name, item]));
    for (const key of Object.keys(inputs)) if (!variables.has(key)) issues.push(issue("unknown_run_input", `Unknown run input: ${key}`));
    for (const definition of task.inputs) {
      const value = Object.hasOwn(inputs, definition.name) ? inputs[definition.name] : definition.defaultValue;
      if (value === undefined) issues.push(issue("missing_run_input", `Missing run input: ${definition.name}`));
      else if (!matchesType(value, definition.type)) issues.push(issue("run_input_type", `Run input ${definition.name} must be ${definition.type}`));
    }
    const canvas = new Set(canvasHardware);
    for (const step of collectTaskSteps(task)) {
      if (step.type !== "tool" || !step.enabled) continue;
      if (!canvas.has(step.hardwareId)) issues.push(issue("hardware_not_on_canvas", `Hardware ${step.hardwareId} is not present on the project wiring canvas`, step.stepId));
      try { this.catalog.getHardware(step.hardwareId); }
      catch { issues.push(issue("unresolved_hardware", `Hardware ${step.hardwareId} is unresolved`, step.stepId)); }
    }
    return issues;
  }
}

function issue(code: string, message: string, nodeId?: string): WorkflowValidationIssue {
  return { severity: "error", code, message, ...(nodeId ? { nodeId } : {}) };
}

export function matchesWorkflowType(value: unknown, type: string): boolean {
  if (type === "unknown") return true;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

function matchesType(value: unknown, type: string): boolean { return matchesWorkflowType(value, type); }
