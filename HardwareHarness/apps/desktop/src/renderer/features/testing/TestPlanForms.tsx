import { PlusIcon, Trash2Icon } from "lucide-react";
import type {
  TestExpressionReference, TestParameter, TestStep, TestStepCatalogItem
} from "@hardwareharness/contracts/testing";
import { Button, Checkbox, Field, IconButton, Input, Select } from "../../ui";
import { SchemaArgumentsForm } from "../manual/SchemaForm.js";
import { initialSchemaValue, schemaProperties, type JsonSchema } from "../manual/schema-form-model.js";
import { ExpressionEditor } from "./ExpressionEditor.js";
import { isRecord, JsonEditor } from "./JsonEditor.js";

const parameterTypes: Record<TestParameter["type"], string> = {
  string: "文本", number: "数值", integer: "整数", boolean: "开关", array: "列表", object: "对象"
};
const bindingKeys = ["hardwareId", "toolName", "bindingRevision", "arguments"];

export function PlanParametersEditor({ value, onChange }: {
  value: TestParameter[];
  onChange: (value: TestParameter[]) => void;
}) {
  const replace = (index: number, item: TestParameter) =>
    onChange(value.map((current, itemIndex) => itemIndex === index ? item : current));
  const add = () => onChange([...value, { name: `parameter${value.length + 1}`, type: "string", required: false }]);
  return (
    <div className="grid gap-2">
      {value.map((item, index) => (
        <div key={`${item.name}-${index}`} className="grid gap-2 rounded-md border border-line bg-surface-0 p-2">
          <div className="grid grid-cols-[minmax(0,1fr)_104px_auto] gap-1.5">
            <Input
              aria-label={`参数 ${index + 1} 名称`}
              className="font-mono"
              value={item.name}
              placeholder="参数名称"
              onChange={(event) => replace(index, { ...item, name: event.target.value })}
            />
            <Select
              aria-label={`参数 ${index + 1} 类型`}
              value={item.type}
              onChange={(event) => replace(index, {
                ...item, type: event.target.value as TestParameter["type"], default: undefined
              })}
            >
              {Object.entries(parameterTypes).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
            </Select>
            <IconButton
              label={`删除参数 ${item.name}`}
              size="icon-sm"
              tooltip={false}
              onClick={() => onChange(value.filter((_entry, itemIndex) => itemIndex !== index))}
            >
              <Trash2Icon />
            </IconButton>
          </div>
          <Input
            aria-label={`参数 ${index + 1} 说明`}
            value={item.description ?? ""}
            placeholder="说明"
            onChange={(event) => replace(index, { ...item, description: event.target.value || undefined })}
          />
          <ParameterDefaultEditor
            parameter={item}
            onChange={(defaultValue) => replace(index, { ...item, default: defaultValue })}
          />
          <label className="flex items-center gap-2 text-xs text-fg-2">
            <Checkbox
              checked={item.required === true}
              onCheckedChange={(checked) => replace(index, { ...item, required: checked === true })}
            />
            运行前必须填写
          </label>
        </div>
      ))}
      <Button size="sm" variant="outline" className="justify-self-start" onClick={add}><PlusIcon />增加运行参数</Button>
      <JsonEditor value={value} onChange={(next) => { if (Array.isArray(next)) onChange(next as TestParameter[]); }} />
    </div>
  );
}

export function RunParametersEditor({ parameters, value, onChange }: {
  parameters: TestParameter[];
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}) {
  return (
    <div className="grid gap-3">
      {parameters.map((parameter) => (
        <SchemaArgumentsForm
          key={parameter.name}
          schema={{
            type: "object",
            properties: { [parameter.name]: parameterSchema(parameter) },
            required: parameter.required ? [parameter.name] : []
          }}
          value={Object.hasOwn(value, parameter.name) ? { [parameter.name]: value[parameter.name] } : {}}
          onChange={(next) => onChange(withKey(value, parameter.name, next))}
        />
      ))}
      {!parameters.length && <p className="text-xs text-fg-3">此计划没有运行参数。</p>}
      <JsonEditor value={value} onChange={(next) => { if (isRecord(next)) onChange(next); }} />
    </div>
  );
}

export function StepSettingsForm({ step, catalogItem, references, onChange }: {
  step: TestStep;
  catalogItem?: TestStepCatalogItem;
  references: TestExpressionReference[];
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const schema = (catalogItem?.settingsSchema ?? { type: "object", properties: {} }) as JsonSchema;
  const properties = schemaProperties(schema) ?? {};
  const expressionEntries = Object.entries(properties).filter(([, child]) => child.format === "hh-cel");
  const ordinaryProperties = Object.fromEntries(Object.entries(properties)
    .filter(([name, child]) => child.format !== "hh-cel" && !bindingKeys.includes(name)));
  const ordinaryKeys = Object.keys(ordinaryProperties);
  const ordinaryValue = Object.fromEntries(
    ordinaryKeys.flatMap((key) => Object.hasOwn(step, key) ? [[key, step[key]]] : [])
  );
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name) => typeof name === "string" && Object.hasOwn(ordinaryProperties, name))
    : [];
  return (
    <div className="grid gap-3">
      {ordinaryKeys.length > 0 && (
        <SchemaArgumentsForm
          showAdvanced
          schema={{ ...schema, properties: ordinaryProperties, required, additionalProperties: false }}
          value={ordinaryValue}
          onChange={(next) => onChange({ ...Object.fromEntries(ordinaryKeys.map((key) => [key, undefined])), ...next })}
        />
      )}
      {expressionEntries.map(([name, child]) => (
        <Field
          key={name}
          label={typeof child.title === "string" ? child.title : name}
          {...(typeof child.description === "string" ? { hint: child.description } : {})}
        >
          <ExpressionEditor
            value={typeof step[name] === "string" ? String(step[name]) : String(child.default ?? "")}
            references={references}
            mode={child["x-hh-expression-mode"] === "condition" ? "condition" : "value"}
            onChange={(expression) => onChange({ [name]: expression })}
          />
        </Field>
      ))}
    </div>
  );
}

export function BoundArgumentsForm({ schema, value, references, onChange }: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  references: TestExpressionReference[];
  onChange: (value: Record<string, unknown>) => void;
}) {
  const properties = schemaProperties(schema) ?? {};
  const required = new Set(Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : []);
  const firstGuaranteed = references.find((item) => item.availability === "guaranteed")?.expression ?? "";
  return (
    <div className="grid gap-2">
      {Object.entries(properties).map(([name, child]) => {
        const bound = value[name];
        const expression = isExpression(bound);
        return (
          <div key={name} className="grid gap-2 rounded-md border border-line bg-surface-0 p-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate text-xs font-medium text-fg">
                {typeof child.title === "string" ? child.title : name}
                {required.has(name) && <span className="ml-0.5 text-fail">*</span>}
              </span>
              <Select
                className="ml-auto w-28"
                aria-label={`${name} 绑定方式`}
                value={expression ? "expression" : "fixed"}
                onChange={(event) => onChange({
                  ...value,
                  [name]: event.target.value === "expression"
                    ? { expression: firstGuaranteed }
                    : initialSchemaValue(child)
                })}
              >
                <option value="fixed">固定值</option>
                <option value="expression">数据引用</option>
              </Select>
            </div>
            {expression ? (
              <ExpressionEditor
                mode="value"
                value={String(bound.expression)}
                references={references}
                onChange={(next) => onChange({ ...value, [name]: { expression: next } })}
              />
            ) : (
              <SchemaArgumentsForm
                schema={{ type: "object", properties: { [name]: child }, required: required.has(name) ? [name] : [] }}
                value={Object.hasOwn(value, name) ? { [name]: bound } : {}}
                onChange={(next) => onChange(withKey(value, name, next))}
              />
            )}
          </div>
        );
      })}
      <JsonEditor value={value} onChange={(next) => { if (isRecord(next)) onChange(next); }} />
    </div>
  );
}

function ParameterDefaultEditor({ parameter, onChange }: {
  parameter: TestParameter;
  onChange: (value: unknown) => void;
}) {
  return (
    <SchemaArgumentsForm
      schema={{
        type: "object",
        properties: { default: { ...parameterSchema(parameter), title: "默认值", description: undefined } }
      }}
      value={parameter.default === undefined ? {} : { default: parameter.default }}
      onChange={(next) => onChange(next.default)}
    />
  );
}

/** Copies `key` from a single-field form result into `value`, deleting it when the form cleared it. */
function withKey(value: Record<string, unknown>, key: string, next: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  if (Object.hasOwn(next, key)) copy[key] = next[key];
  else delete copy[key];
  return copy;
}

function parameterSchema(parameter: TestParameter): JsonSchema {
  return {
    type: parameter.type,
    title: parameter.name,
    description: parameter.description,
    ...(parameter.default === undefined ? {} : { default: parameter.default }),
    ...(parameter.type === "array" ? { items: {} } : {}),
    ...(parameter.type === "object" ? { properties: {}, additionalProperties: true } : {})
  };
}

function isExpression(value: unknown): value is { expression: string } {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.expression === "string";
}
