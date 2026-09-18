import { useEffect, useMemo, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import type { TestExpressionReference, TestParameter, TestPlan, TestStep, TestStepCatalogItem } from "@hardwareharness/contracts/testing";
import { Button } from "../../shared/ui/button";
import { Checkbox } from "../../shared/ui/checkbox";
import { Field, Input, Select, Textarea } from "../../shared/ui/input";
import { SchemaArgumentsForm } from "../manual/SchemaForm.js";
import { initialSchemaValue, schemaProperties, type JsonSchema } from "../manual/schema-form-model.js";
import { ExpressionEditor } from "./ExpressionEditor.js";

export function PlanParametersEditor({ value, onChange }: { value: TestParameter[]; onChange: (value: TestParameter[]) => void }) {
  return <div className="grid gap-2"><div className="grid gap-2">{value.map((item, index) => <div key={`${item.name}-${index}`} className="grid gap-2 rounded-md border p-2">
    <div className="grid grid-cols-[1fr_110px_auto] gap-2"><Input aria-label={`参数 ${index + 1} 名称`} value={item.name} placeholder="参数名称" onChange={(event) => replace(index, { ...item, name: event.target.value })} /><Select aria-label={`参数 ${index + 1} 类型`} value={item.type} onChange={(event) => replace(index, { ...item, type: event.target.value as TestParameter["type"], default: undefined })}>{["string", "number", "integer", "boolean", "array", "object"].map((type) => <option key={type}>{type}</option>)}</Select><Button size="icon-sm" variant="ghost" aria-label={`删除参数 ${item.name}`} onClick={() => onChange(value.filter((_entry, itemIndex) => itemIndex !== index))}><Trash2Icon /></Button></div>
    <Input aria-label={`参数 ${index + 1} 说明`} value={item.description ?? ""} placeholder="说明" onChange={(event) => replace(index, { ...item, description: event.target.value || undefined })} />
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3"><label className="flex items-center gap-2 text-xs"><Checkbox checked={item.required === true} onCheckedChange={(checked) => replace(index, { ...item, required: checked === true })} />必填</label><ParameterDefaultEditor parameter={item} onChange={(defaultValue) => replace(index, { ...item, default: defaultValue })} /></div>
  </div>)}</div><Button size="sm" variant="outline" onClick={() => onChange([...value, { name: `parameter${value.length + 1}`, type: "string", required: false }])}><PlusIcon />增加运行参数</Button><details className="rounded-md border p-2"><summary className="cursor-pointer text-xs text-muted-foreground">高级 JSON</summary><JsonEditor value={value} onChange={(next) => { if (Array.isArray(next)) onChange(next as TestParameter[]); }} /></details></div>;
  function replace(index: number, item: TestParameter) { onChange(value.map((current, itemIndex) => itemIndex === index ? item : current)); }
}

export function RunParametersEditor({ parameters, value, onChange }: { parameters: TestParameter[]; value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void }) {
  return <div className="grid gap-3">{parameters.map((parameter) => {
    const schema = parameterSchema(parameter);
    return <SchemaArgumentsForm key={parameter.name} schema={{ type: "object", properties: { [parameter.name]: schema }, required: parameter.required ? [parameter.name] : [] }} value={Object.hasOwn(value, parameter.name) ? { [parameter.name]: value[parameter.name] } : {}} onChange={(next) => {
      const copy = { ...value }; if (Object.hasOwn(next, parameter.name)) copy[parameter.name] = next[parameter.name]; else delete copy[parameter.name]; onChange(copy);
    }} />;
  })}{!parameters.length && <div className="text-xs text-muted-foreground">此计划没有运行参数。</div>}<details className="rounded-md border p-2"><summary className="cursor-pointer text-xs text-muted-foreground">高级 JSON</summary><JsonEditor value={value} onChange={(next) => { if (isRecord(next)) onChange(next); }} /></details></div>;
}

export function StepSettingsForm({ step, catalogItem, references, onChange }: { step: TestStep; catalogItem?: TestStepCatalogItem; references: TestExpressionReference[]; onChange: (patch: Record<string, unknown>) => void }) {
  const schema = (catalogItem?.settingsSchema ?? { type: "object", properties: {} }) as JsonSchema;
  const properties = schemaProperties(schema) ?? {};
  const expressionEntries = Object.entries(properties).filter(([, child]) => child.format === "hh-cel");
  const ordinaryEntries = Object.entries(properties).filter(([, child]) => child.format !== "hh-cel");
  const ordinaryProperties = Object.fromEntries(ordinaryEntries.filter(([name]) => !["hardwareId", "toolName", "bindingRevision", "arguments"].includes(name)));
  const ordinaryValue = Object.fromEntries(Object.keys(ordinaryProperties).flatMap((key) => Object.hasOwn(step, key) ? [[key, step[key]]] : []));
  return <div className="grid gap-3">{Object.keys(ordinaryProperties).length > 0 && <SchemaArgumentsForm showAdvanced schema={{ ...schema, properties: ordinaryProperties, required: Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === "string" && Object.hasOwn(ordinaryProperties, name)) : [] }} value={ordinaryValue} onChange={(next) => onChange({ ...Object.fromEntries(Object.keys(ordinaryProperties).map((key) => [key, undefined])), ...next })} />}{expressionEntries.map(([name, child]) => <Field key={name} label={typeof child.title === "string" ? child.title : name} {...(typeof child.description === "string" ? { hint: child.description } : {})}><ExpressionEditor value={typeof step[name] === "string" ? String(step[name]) : String(child.default ?? "")} references={references} mode={child["x-hh-expression-mode"] === "condition" ? "condition" : "value"} onChange={(expression) => onChange({ [name]: expression })} /></Field>)}</div>;
}

export function BoundArgumentsForm({ schema, value, references, onChange }: { schema: JsonSchema; value: Record<string, unknown>; references: TestExpressionReference[]; onChange: (value: Record<string, unknown>) => void }) {
  const properties = schemaProperties(schema) ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  return <div className="grid gap-3">{Object.entries(properties).map(([name, child]) => {
    const bound = value[name]; const expression = isExpression(bound);
    return <div key={name} className="grid gap-2 rounded-md border p-2"><div className="flex items-center gap-2"><span className="text-xs font-medium">{typeof child.title === "string" ? child.title : name}{required.has(name) ? " *" : ""}</span><Select className="ml-auto w-28" aria-label={`${name} 绑定方式`} value={expression ? "expression" : "fixed"} onChange={(event) => { const next = { ...value, [name]: event.target.value === "expression" ? { expression: references.find((item) => item.availability === "guaranteed")?.expression ?? "" } : initialSchemaValue(child) }; onChange(next); }}><option value="fixed">固定值</option><option value="expression">数据引用</option></Select></div>{expression ? <ExpressionEditor mode="value" value={String(bound.expression)} references={references} onChange={(next) => onChange({ ...value, [name]: { expression: next } })} /> : <SchemaArgumentsForm schema={{ type: "object", properties: { [name]: child }, required: required.has(name) ? [name] : [] }} value={Object.hasOwn(value, name) ? { [name]: bound } : {}} onChange={(next) => { const copy = { ...value }; if (Object.hasOwn(next, name)) copy[name] = next[name]; else delete copy[name]; onChange(copy); }} />}</div>;
  })}<details className="rounded-md border p-2"><summary className="cursor-pointer text-xs text-muted-foreground">高级 JSON</summary><JsonEditor value={value} onChange={(next) => { if (isRecord(next)) onChange(next); }} /></details></div>;
}

function ParameterDefaultEditor({ parameter, onChange }: { parameter: TestParameter; onChange: (value: unknown) => void }) { const schema = parameterSchema(parameter); return <SchemaArgumentsForm schema={{ type: "object", properties: { default: schema } }} value={parameter.default === undefined ? {} : { default: parameter.default }} onChange={(next) => onChange(next.default)} />; }
function parameterSchema(parameter: TestParameter): JsonSchema { return { type: parameter.type, title: parameter.name, description: parameter.description, ...(parameter.default === undefined ? {} : { default: parameter.default }), ...(parameter.type === "array" ? { items: {} } : {}), ...(parameter.type === "object" ? { properties: {}, additionalProperties: true } : {}) }; }
function isExpression(value: unknown): value is { expression: string } { return isRecord(value) && Object.keys(value).length === 1 && typeof value.expression === "string"; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function JsonEditor({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) { const [text, setText] = useState(() => JSON.stringify(value, null, 2)); const [error, setError] = useState<string>(); useEffect(() => setText(JSON.stringify(value, null, 2)), [value]); return <div className="mt-2 grid gap-1"><Textarea className="min-h-32 font-mono text-[11px]" value={text} onChange={(event) => { setText(event.target.value); try { onChange(JSON.parse(event.target.value)); setError(undefined); } catch { setError("请输入合法 JSON"); } }} />{error && <span className="text-[10px] text-destructive">{error}</span>}</div>; }
