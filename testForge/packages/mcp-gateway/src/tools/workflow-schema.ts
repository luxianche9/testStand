import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Recursive workflow JSON Schema has one canonical explicit representation. */
export const UPDATE_TEST_TASK_INPUT_SCHEMA: Tool["inputSchema"] = {
  type: "object",
  properties: { task: { $ref: "#/$defs/testTask" } },
  required: ["task"],
  additionalProperties: false,
  $defs: {
    variableDefinition: {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        type: { type: "string", enum: ["string", "number", "boolean", "object", "array", "unknown"] },
        defaultValue: {},
        description: { type: "string" }
      },
      required: ["name", "type"],
      additionalProperties: false
    },
    valueTemplate: {
      oneOf: [
        { type: "object", properties: { kind: { const: "literal" }, value: {} }, required: ["kind", "value"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "variable" }, path: { type: "string", minLength: 1 } }, required: ["kind", "path"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "object" }, entries: { type: "object", additionalProperties: { $ref: "#/$defs/valueTemplate" } } }, required: ["kind", "entries"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "array" }, items: { type: "array", items: { $ref: "#/$defs/valueTemplate" } } }, required: ["kind", "items"], additionalProperties: false }
      ]
    },
    expression: {
      oneOf: [
        { type: "object", properties: { kind: { const: "literal" }, value: {} }, required: ["kind", "value"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "variable" }, path: { type: "string", minLength: 1 } }, required: ["kind", "path"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "unary" }, operator: { type: "string", enum: ["not", "negate"] }, operand: { $ref: "#/$defs/expression" } }, required: ["kind", "operator", "operand"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "binary" }, operator: { type: "string", enum: ["add", "subtract", "multiply", "divide", "modulo", "eq", "neq", "gt", "gte", "lt", "lte"] }, left: { $ref: "#/$defs/expression" }, right: { $ref: "#/$defs/expression" } }, required: ["kind", "operator", "left", "right"], additionalProperties: false },
        { type: "object", properties: { kind: { const: "logical" }, operator: { type: "string", enum: ["and", "or"] }, operands: { type: "array", minItems: 1, items: { $ref: "#/$defs/expression" } } }, required: ["kind", "operator", "operands"], additionalProperties: false }
      ]
    },
    outputBinding: {
      type: "object",
      properties: { variable: { type: "string", minLength: 1 }, pointer: { type: "string", default: "" } },
      required: ["variable"],
      additionalProperties: false
    },
    retry: {
      type: "object",
      properties: {
        maxAttempts: { type: "integer", minimum: 1, maximum: 10 },
        delayMs: { type: "integer", minimum: 0, maximum: 300000 },
        backoff: { type: "string", enum: ["fixed", "exponential"], default: "fixed" },
        retryOn: { type: "array", items: { type: "string", enum: ["permission_denied", "invalid_argument", "unavailable", "conflict", "not_found", "validation_failed", "requires_project", "safe_stop_failed", "invalid_response", "loop_limit", "assertion_failed", "project_exists", "invalid_project", "project_uninitialized", "invalid_project_folder", "cancelled", "error"] }, default: ["unavailable"] }
      },
      required: ["maxAttempts", "delayMs"],
      additionalProperties: false
    },
    step: {
      oneOf: [
        {
          type: "object",
          properties: {
            stepId: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, enabled: { type: "boolean", default: true }, type: { const: "tool" },
            toolName: { type: "string", minLength: 1 }, hardwareId: { type: "string", minLength: 1 }, arguments: { type: "object", additionalProperties: { $ref: "#/$defs/valueTemplate" } },
            outputBindings: { type: "array", items: { $ref: "#/$defs/outputBinding" } }, timeoutMs: { type: "integer", minimum: 100, maximum: 1800000 }, idempotent: { type: "boolean", default: false }, retry: { $ref: "#/$defs/retry" }
          },
          required: ["stepId", "label", "type", "toolName", "hardwareId", "arguments", "outputBindings", "timeoutMs", "retry"],
          additionalProperties: false
        },
        { type: "object", properties: { stepId: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, enabled: { type: "boolean", default: true }, type: { const: "delay" }, durationMs: { $ref: "#/$defs/valueTemplate" } }, required: ["stepId", "label", "type", "durationMs"], additionalProperties: false },
        { type: "object", properties: { stepId: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, enabled: { type: "boolean", default: true }, type: { const: "set_variable" }, variable: { type: "string", minLength: 1 }, value: { $ref: "#/$defs/valueTemplate" } }, required: ["stepId", "label", "type", "variable", "value"], additionalProperties: false },
        { type: "object", properties: { stepId: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, enabled: { type: "boolean", default: true }, type: { const: "assert" }, expression: { $ref: "#/$defs/expression" }, message: { type: "string" } }, required: ["stepId", "label", "type", "expression", "message"], additionalProperties: false },
        { type: "object", properties: { stepId: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, enabled: { type: "boolean", default: true }, type: { const: "if" }, condition: { $ref: "#/$defs/expression" }, then: { type: "array", items: { $ref: "#/$defs/step" } }, else: { type: "array", items: { $ref: "#/$defs/step" } } }, required: ["stepId", "label", "type", "condition", "then", "else"], additionalProperties: false },
        { type: "object", properties: { stepId: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, enabled: { type: "boolean", default: true }, type: { const: "loop" }, mode: { type: "string", enum: ["count", "while"] }, count: { $ref: "#/$defs/valueTemplate" }, condition: { $ref: "#/$defs/expression" }, maxIterations: { type: "integer", minimum: 1, maximum: 10000 }, indexVariable: { type: "string", minLength: 1 }, body: { type: "array", items: { $ref: "#/$defs/step" } } }, required: ["stepId", "label", "type", "mode", "maxIterations", "indexVariable", "body"], additionalProperties: false },
        { type: "object", properties: { stepId: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, enabled: { type: "boolean", default: true }, type: { const: "parallel" }, branches: { type: "array", minItems: 2, items: { type: "object", properties: { branchId: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, steps: { type: "array", items: { $ref: "#/$defs/step" } } }, required: ["branchId", "name", "steps"], additionalProperties: false } } }, required: ["stepId", "label", "type", "branches"], additionalProperties: false },
        { type: "object", properties: { stepId: { type: "string", minLength: 1 }, label: { type: "string", minLength: 1 }, enabled: { type: "boolean", default: true }, type: { const: "operator" }, prompt: { type: "string", minLength: 1 }, options: { type: "array", minItems: 1, items: { type: "object", properties: { label: { type: "string", minLength: 1 }, value: {} }, required: ["label", "value"], additionalProperties: false } }, resultVariable: { type: "string", minLength: 1 } }, required: ["stepId", "label", "type", "prompt", "options"], additionalProperties: false }
      ]
    },
    testTask: {
      type: "object",
      properties: {
        formatVersion: { const: 2 }, taskId: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 },
        inputs: { type: "array", items: { $ref: "#/$defs/variableDefinition" } }, variables: { type: "array", items: { $ref: "#/$defs/variableDefinition" } },
        setup: { type: "array", items: { $ref: "#/$defs/step" } }, steps: { type: "array", items: { $ref: "#/$defs/step" } }, cleanup: { type: "array", items: { $ref: "#/$defs/step" } }
      },
      required: ["formatVersion", "taskId", "name", "inputs", "variables", "setup", "steps", "cleanup"],
      additionalProperties: false
    }
  }
};
