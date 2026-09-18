import { useCallback, useEffect, useRef, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "../../shared/ui/button";
import { Checkbox } from "../../shared/ui/checkbox";
import { Input, Select, Textarea } from "../../shared/ui/input";
import { childSchema, initialSchemaValue, requiresJsonFallback, schemaProperties, schemaRequired, schemaType, type JsonSchema } from "./schema-form-model.js";

type JsonValidityReporter = (path: string, valid: boolean) => void;

export function SchemaArgumentsForm({ schema, value, onChange, onValidityChange, preserveHardwareId = false, showAdvanced = false }: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  onValidityChange?: (valid: boolean) => void;
  preserveHardwareId?: boolean;
  showAdvanced?: boolean;
}) {
  const [invalidJsonPaths, setInvalidJsonPaths] = useState<Set<string>>(() => new Set());
  const reportJsonValidity = useCallback<JsonValidityReporter>((path, valid) => {
    setInvalidJsonPaths((current) => {
      if (valid === !current.has(path)) return current;
      const next = new Set(current);
      if (valid) next.delete(path); else next.add(path);
      return next;
    });
  }, []);
  useEffect(() => { onValidityChange?.(invalidJsonPaths.size === 0); }, [invalidJsonPaths, onValidityChange]);

  const rootChoices = (Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : []).filter(isSchema);
  if (rootChoices.length) return <RootChoiceForm choices={rootChoices} value={value} onChange={onChange} reportJsonValidity={reportJsonValidity} showAdvanced={showAdvanced} />;

  if (requiresJsonFallback(schema)) {
    return <div className="grid gap-2"><div className="rounded-md border border-warning/35 bg-warning/8 px-3 py-2 text-xs text-warning">该 Schema 包含无法可靠生成表单的结构，请在高级 JSON 中编辑。</div><details open className="rounded-md border p-2"><summary className="cursor-pointer text-xs font-medium">高级 JSON</summary><div className="mt-2"><JsonValueEditor
      label="参数"
      value={value}
      required
      description={typeof schema.description === "string" ? schema.description : "使用 JSON 编辑完整工具参数。"}
      path="参数"
      reportJsonValidity={reportJsonValidity}
      validateParsed={(parsed) => isRecord(parsed) ? undefined : "工具参数必须是 JSON object"}
      onChange={(parsed) => {
        if (!isRecord(parsed)) return;
        if (preserveHardwareId) { onChange(parsed); return; }
        const { hardwareId: _injected, ...argumentsValue } = parsed;
        onChange(argumentsValue);
      }}
    /></div></details></div>;
  }
  if (schemaType(schema) !== "object" || !schemaProperties(schema)) {
    return <div className="flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/6 px-3.5 py-2.5 text-xs text-destructive"><span>工具输入 Schema 的根节点必须是 object。</span></div>;
  }
  return <div className="grid gap-2"><ObjectFields schema={schema} value={value} onChange={onChange} path="参数" reportJsonValidity={reportJsonValidity} />{showAdvanced && <details className="rounded-md border p-2"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">高级 JSON</summary><div className="mt-2"><JsonValueEditor label="完整值" value={value} required description="专家模式：直接编辑完整对象。" path="参数.高级JSON" reportJsonValidity={reportJsonValidity} validateParsed={(parsed) => isRecord(parsed) ? undefined : "必须是 JSON object"} onChange={(parsed) => { if (isRecord(parsed)) onChange(parsed); }} /></div></details>}</div>;
}

function ObjectFields({ schema, value, onChange, path, reportJsonValidity }: { schema: JsonSchema; value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void; path: string; reportJsonValidity: JsonValidityReporter }) {
  const properties = schemaProperties(schema) ?? {};
  const required = new Set(schemaRequired(schema));
  return <div className="flex flex-col gap-2.5">
    {Object.entries(properties).map(([name, child]) => {
      const present = Object.hasOwn(value, name);
      const isRequired = required.has(name);
      return <div className="flex flex-col gap-1.5" key={name}>
        {!isRequired && <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Checkbox checked={present} onCheckedChange={(checked) => {
          if (checked) onChange({ ...value, [name]: initialSchemaValue(child) });
          else { const { [name]: _removed, ...rest } = value; onChange(rest); }
        }} /><span>启用可选参数</span></label>}
        {(isRequired || present) && <SchemaField
          label={typeof child.title === "string" ? child.title : name}
          schema={child}
          value={value[name]}
          required={isRequired}
          path={`${path}.${name}`}
          reportJsonValidity={reportJsonValidity}
          onChange={(next) => onChange({ ...value, [name]: next })}
        />}
      </div>;
    })}
    {Object.hasOwn(schema, "additionalProperties") && schema.additionalProperties !== false && <AdditionalPropertiesField {...(isSchema(schema.additionalProperties) ? { schema: schema.additionalProperties } : {})} declared={new Set(Object.keys(properties))} value={value} onChange={onChange} path={path} reportJsonValidity={reportJsonValidity} />}
    {!Object.keys(properties).length && <small className="text-xs text-muted-foreground">该工具没有可编辑参数。</small>}
  </div>;
}

function RootChoiceForm({ choices, value, onChange, reportJsonValidity, showAdvanced }: { choices: JsonSchema[]; value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void; reportJsonValidity: JsonValidityReporter; showAdvanced: boolean }) {
  const initial = Math.max(0, choices.findIndex((choice) => schemaType(choice) === "object" && simpleTypeMatches(choice, value)));
  const [selected, setSelected] = useState(initial);
  const choice = choices[selected] ?? choices[0]!;
  if (schemaType(choice) !== "object" || !schemaProperties(choice)) return <div className="grid gap-2"><div className="rounded-md border border-warning/35 bg-warning/8 px-3 py-2 text-xs text-warning">所选分支无法可靠生成对象表单，请使用高级 JSON。</div><JsonValueEditor label="完整值" value={value} required description="专家模式：直接编辑完整对象。" path="参数.高级JSON" reportJsonValidity={reportJsonValidity} validateParsed={(parsed) => isRecord(parsed) ? undefined : "必须是 JSON object"} onChange={(parsed) => { if (isRecord(parsed)) onChange(parsed); }} /></div>;
  return <div className="grid gap-2"><Select aria-label="Schema 分支" value={selected} onChange={(event) => { const index = Number(event.target.value); setSelected(index); const next = initialSchemaValue(choices[index]!); if (isRecord(next)) onChange(next); }}><option disabled value="">选择结构</option>{choices.map((item, index) => <option key={index} value={index}>{typeof item.title === "string" ? item.title : `选项 ${index + 1}`}</option>)}</Select><ObjectFields schema={choice} value={value} onChange={onChange} path="参数" reportJsonValidity={reportJsonValidity} />{showAdvanced && <details className="rounded-md border p-2"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">高级 JSON</summary><JsonValueEditor label="完整值" value={value} required description="专家模式：直接编辑完整对象。" path="参数.高级JSON" reportJsonValidity={reportJsonValidity} validateParsed={(parsed) => isRecord(parsed) ? undefined : "必须是 JSON object"} onChange={(parsed) => { if (isRecord(parsed)) onChange(parsed); }} /></details>}</div>;
}

function AdditionalPropertiesField({ schema, declared, value, onChange, path, reportJsonValidity }: { schema?: JsonSchema; declared: Set<string>; value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void; path: string; reportJsonValidity: JsonValidityReporter }) {
  const entries = Object.entries(value).filter(([name]) => !declared.has(name));
  const [newKey, setNewKey] = useState("");
  const add = () => { const key = newKey.trim(); if (!key || Object.hasOwn(value, key)) return; onChange({ ...value, [key]: schema ? initialSchemaValue(schema) : "" }); setNewKey(""); };
  return <fieldset className="m-0 min-w-0 rounded-xl bg-secondary/30 p-2.5 ring-1 ring-border"><legend className="px-1.5 text-[11px] font-semibold">扩展键值</legend><div className="grid gap-2">{entries.map(([name, entry]) => <div key={name} className="grid grid-cols-[120px_minmax(0,1fr)_auto] items-end gap-2"><Input aria-label={`${name} 键名`} value={name} onChange={(event) => { const nextName = event.target.value.trim(); if (!nextName || nextName === name || Object.hasOwn(value, nextName)) return; const next = { ...value }; delete next[name]; next[nextName] = entry; onChange(next); }} />{schema ? <SchemaField label={name} schema={schema} value={entry} required path={`${path}.${name}`} reportJsonValidity={reportJsonValidity} onChange={(next) => onChange({ ...value, [name]: next })} /> : <JsonValueEditor label={name} value={entry} required={false} description="任意 JSON 值" path={`${path}.${name}`} reportJsonValidity={reportJsonValidity} onChange={(next) => onChange({ ...value, [name]: next })} />}<Button size="icon-sm" variant="ghost" aria-label={`删除 ${name}`} onClick={() => { const next = { ...value }; delete next[name]; onChange(next); }}><Trash2Icon /></Button></div>)}<div className="flex gap-2"><Input aria-label="新增扩展键" value={newKey} placeholder="键名" onChange={(event) => setNewKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} /><Button size="sm" variant="outline" disabled={!newKey.trim() || Object.hasOwn(value, newKey.trim())} onClick={add}><PlusIcon />增加键</Button></div></div></fieldset>;
}

function FieldShell({ label, required, requiredText = "必填", description, error, children }: {
  label: string;
  required?: boolean;
  requiredText?: string;
  description?: string | undefined;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return <label className="grid content-start gap-1.5">
    <span className="text-xs text-muted-foreground">{label}{required && <i className="ml-0.5 text-destructive not-italic">{requiredText}</i>}</span>
    {children}
    {description && <small className="text-xs text-muted-foreground">{description}</small>}
    {error && <small className="text-[11px] text-destructive">{error}</small>}
  </label>;
}

function SchemaField({ label, schema, value, required, path, reportJsonValidity, onChange }: { label: string; schema: JsonSchema; value: unknown; required: boolean; path: string; reportJsonValidity: JsonValidityReporter; onChange: (value: unknown) => void }) {
  const description = typeof schema.description === "string" ? schema.description : undefined;
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  const type = schemaType(schema);
  const choices = (Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : []).filter(isSchema);
  if (choices.length) return <ChoiceSchemaField label={label} choices={choices} value={value} required={required} path={path} reportJsonValidity={reportJsonValidity} onChange={onChange} />;
  const declaredTypes = Array.isArray(schema.type) ? schema.type.filter((item): item is string => typeof item === "string") : [];
  if (declaredTypes.includes("null") && declaredTypes.some((item) => item !== "null")) {
    const nonNull = declaredTypes.filter((item) => item !== "null");
    const child = { ...schema, type: nonNull.length === 1 ? nonNull[0] : nonNull };
    return <div className="grid gap-1.5"><label className="flex items-center gap-2 text-xs"><Checkbox checked={value === null} onCheckedChange={(checked) => onChange(checked ? null : initialSchemaValue(child))} />使用空值</label>{value !== null && <SchemaField label={label} schema={child} value={value} required={required} path={path} reportJsonValidity={reportJsonValidity} onChange={onChange} />}</div>;
  }
  if (Object.hasOwn(schema, "const")) return <FieldShell label={label} required={required} description={description}><Input value={display(schema.const)} readOnly /></FieldShell>;
  if (enumValues?.length) return <FieldShell label={label} required={required} description={description}><Select value={display(value)} onChange={(event) => onChange(enumValues.find((item) => display(item) === event.target.value))}>{enumValues.map((item) => <option key={display(item)} value={display(item)}>{display(item)}</option>)}</Select></FieldShell>;
  if (requiresJsonFallback(schema)) return <JsonValueEditor label={label} value={value} required={required} description={description} path={path} reportJsonValidity={reportJsonValidity} onChange={onChange} />;
  if (type === "object") return <fieldset className="m-0 min-w-0 rounded-xl bg-secondary/40 p-2.5 shadow-sm ring-1 ring-border"><legend className="px-1.5 text-[11px] font-semibold">{label}{required ? " *" : ""}</legend>{description && <small className="text-xs text-muted-foreground">{description}</small>}<ObjectFields schema={schema} value={asObject(value)} onChange={onChange} path={path} reportJsonValidity={reportJsonValidity} /></fieldset>;
  if (type === "array") return <ArrayField label={label} schema={schema} value={Array.isArray(value) ? value : []} required={required} description={description} onChange={onChange} path={path} reportJsonValidity={reportJsonValidity} />;
  if (type === "boolean") return <label className="grid content-start gap-1.5"><span className="flex items-center gap-2"><Checkbox checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked === true)} /><span className="text-xs">{label}{required ? " *" : ""}</span></span>{description && <small className="text-xs text-muted-foreground">{description}</small>}</label>;
  if (type === "number" || type === "integer") return <FieldShell label={label} required={required} description={description}><div className="flex items-center gap-2"><Input type="number" step={type === "integer" ? 1 : "any"} value={typeof value === "number" ? value : ""} min={typeof schema.minimum === "number" ? schema.minimum : undefined} max={typeof schema.maximum === "number" ? schema.maximum : undefined} onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))} />{typeof schema["x-hh-unit"] === "string" && <span className="text-[11px] text-muted-foreground">{String(schema["x-hh-unit"])}</span>}</div></FieldShell>;
  if (type === "null") return <FieldShell label={label}><Input value="null" readOnly /></FieldShell>;
  return <FieldShell label={label} required={required} description={description}><Input type="text" value={typeof value === "string" ? value : ""} minLength={typeof schema.minLength === "number" ? schema.minLength : undefined} maxLength={typeof schema.maxLength === "number" ? schema.maxLength : undefined} pattern={typeof schema.pattern === "string" ? schema.pattern : undefined} onChange={(event) => onChange(event.target.value)} /></FieldShell>;
}

function ChoiceSchemaField({ label, choices, value, required, path, reportJsonValidity, onChange }: { label: string; choices: JsonSchema[]; value: unknown; required: boolean; path: string; reportJsonValidity: JsonValidityReporter; onChange: (value: unknown) => void }) {
  const initial = Math.max(0, choices.findIndex((choice) => simpleTypeMatches(choice, value)));
  const [selected, setSelected] = useState(initial);
  const choice = choices[selected] ?? choices[0]!;
  return <div className="grid gap-2"><Select aria-label={`${label} 类型`} value={selected} onChange={(event) => { const index = Number(event.target.value); setSelected(index); onChange(initialSchemaValue(choices[index]!)); }}>{choices.map((item, index) => <option key={index} value={index}>{typeof item.title === "string" ? item.title : schemaType(item) ?? `选项 ${index + 1}`}</option>)}</Select><SchemaField label={label} schema={choice} value={value} required={required} path={path} reportJsonValidity={reportJsonValidity} onChange={onChange} /></div>;
}

function ArrayField({ label, schema, value, required, description, onChange, path, reportJsonValidity }: { label: string; schema: JsonSchema; value: unknown[]; required: boolean; description: string | undefined; onChange: (value: unknown[]) => void; path: string; reportJsonValidity: JsonValidityReporter }) {
  const item = childSchema(schema);
  if (!item) return <JsonValueEditor label={label} value={value} required={required} description={description} path={path} reportJsonValidity={reportJsonValidity} validateParsed={(parsed) => Array.isArray(parsed) ? undefined : "参数必须是 JSON array"} onChange={(next) => { if (Array.isArray(next)) onChange(next); }} />;
  return <fieldset className="m-0 min-w-0 rounded-xl bg-secondary/40 p-2.5 shadow-sm ring-1 ring-border"><legend className="px-1.5 text-[11px] font-semibold">{label}{required ? " *" : ""}</legend>{description && <small className="text-xs text-muted-foreground">{description}</small>}
    {value.map((entry, index) => <div className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2" key={index}><SchemaField label={`#${index + 1}`} schema={item} value={entry} required path={`${path}.${index}`} reportJsonValidity={reportJsonValidity} onChange={(next) => onChange(value.map((current, itemIndex) => itemIndex === index ? next : current))} /><Button variant="ghost" size="icon-sm" aria-label={`删除 ${label} 第 ${index + 1} 项`} onClick={() => onChange(value.filter((_entry, itemIndex) => itemIndex !== index))}><Trash2Icon /></Button></div>)}
    <Button variant="outline" size="sm" onClick={() => onChange([...value, initialSchemaValue(item)])}><PlusIcon />新增一项</Button>
  </fieldset>;
}

function JsonValueEditor({ label, value, required, description, path, reportJsonValidity, validateParsed, onChange }: {
  label: string;
  value: unknown;
  required: boolean;
  description: string | undefined;
  path: string;
  reportJsonValidity: JsonValidityReporter;
  validateParsed?: (value: unknown) => string | undefined;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(() => pretty(value));
  const [error, setError] = useState<string>();
  const emittedValue = useRef(value);
  useEffect(() => {
    reportJsonValidity(path, !error);
    return () => reportJsonValidity(path, true);
  }, [error, path, reportJsonValidity]);
  useEffect(() => {
    if (jsonEqual(emittedValue.current, value)) return;
    emittedValue.current = value;
    setText(pretty(value));
    setError(undefined);
  }, [value]);
  return <FieldShell label={label} required={required} requiredText="必填 · JSON" description={description} error={error}><Textarea className="min-h-[120px] font-mono text-[11px]" value={text} onChange={(event) => {
    const next = event.target.value;
    setText(next);
    try {
      const parsed = JSON.parse(next) as unknown;
      const validationError = validateParsed?.(parsed);
      if (validationError) { setError(validationError); return; }
      emittedValue.current = parsed;
      onChange(parsed);
      setError(undefined);
    }
    catch { setError("请输入合法 JSON"); }
  }} /></FieldShell>;
}

function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function pretty(value: unknown): string { try { return JSON.stringify(value, null, 2); } catch { return String(value ?? ""); } }
function display(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value); }
function isSchema(value: unknown): value is JsonSchema { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function simpleTypeMatches(schema: JsonSchema, value: unknown): boolean { const type = schemaType(schema); if (type === "array") return Array.isArray(value); if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value); if (type === "null") return value === null; return type ? typeof value === type : false; }
function jsonEqual(left: unknown, right: unknown): boolean { try { return JSON.stringify(left) === JSON.stringify(right); } catch { return Object.is(left, right); } }
