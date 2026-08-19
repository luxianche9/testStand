import { useCallback, useEffect, useRef, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "../../shared/ui/button";
import { Checkbox } from "../../shared/ui/checkbox";
import { Input, Select, Textarea } from "../../shared/ui/input";
import { childSchema, initialSchemaValue, requiresJsonFallback, schemaProperties, schemaRequired, schemaType, type JsonSchema } from "./schema-form-model.js";

type JsonValidityReporter = (path: string, valid: boolean) => void;

export function SchemaArgumentsForm({ schema, value, onChange, onValidityChange }: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  onValidityChange?: (valid: boolean) => void;
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

  if (requiresJsonFallback(schema)) {
    return <JsonValueEditor
      label="参数"
      value={value}
      required
      description={typeof schema.description === "string" ? schema.description : "使用 JSON 编辑完整工具参数。"}
      path="参数"
      reportJsonValidity={reportJsonValidity}
      validateParsed={(parsed) => isRecord(parsed) ? undefined : "工具参数必须是 JSON object"}
      onChange={(parsed) => {
        if (!isRecord(parsed)) return;
        const { hardwareId: _injected, ...argumentsValue } = parsed;
        onChange(argumentsValue);
      }}
    />;
  }
  if (schemaType(schema) !== "object" || !schemaProperties(schema)) {
    return <div className="flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/6 px-3.5 py-2.5 text-xs text-destructive"><span>工具输入 Schema 的根节点必须是 object。</span></div>;
  }
  return <ObjectFields schema={schema} value={value} onChange={onChange} path="参数" reportJsonValidity={reportJsonValidity} />;
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
    {!Object.keys(properties).length && <small className="text-xs text-muted-foreground">该工具没有可编辑参数。</small>}
  </div>;
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
  if (Object.hasOwn(schema, "const")) return <FieldShell label={label} required={required} description={description}><Input value={display(schema.const)} readOnly /></FieldShell>;
  if (enumValues?.length) return <FieldShell label={label} required={required} description={description}><Select value={display(value)} onChange={(event) => onChange(enumValues.find((item) => display(item) === event.target.value))}>{enumValues.map((item) => <option key={display(item)} value={display(item)}>{display(item)}</option>)}</Select></FieldShell>;
  if (requiresJsonFallback(schema)) return <JsonValueEditor label={label} value={value} required={required} description={description} path={path} reportJsonValidity={reportJsonValidity} onChange={onChange} />;
  if (type === "object") return <fieldset className="m-0 min-w-0 rounded-md border p-2.5"><legend className="px-1.5 text-[11px] font-semibold">{label}{required ? " *" : ""}</legend>{description && <small className="text-xs text-muted-foreground">{description}</small>}<ObjectFields schema={schema} value={asObject(value)} onChange={onChange} path={path} reportJsonValidity={reportJsonValidity} /></fieldset>;
  if (type === "array") return <ArrayField label={label} schema={schema} value={Array.isArray(value) ? value : []} required={required} description={description} onChange={onChange} path={path} reportJsonValidity={reportJsonValidity} />;
  if (type === "boolean") return <label className="grid content-start gap-1.5"><span className="flex items-center gap-2"><Checkbox checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked === true)} /><span className="text-xs">{label}{required ? " *" : ""}</span></span>{description && <small className="text-xs text-muted-foreground">{description}</small>}</label>;
  if (type === "number" || type === "integer") return <FieldShell label={label} required={required} description={description}><Input type="number" step={type === "integer" ? 1 : "any"} value={typeof value === "number" ? value : ""} min={typeof schema.minimum === "number" ? schema.minimum : undefined} max={typeof schema.maximum === "number" ? schema.maximum : undefined} onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))} /></FieldShell>;
  if (type === "null") return <FieldShell label={label}><Input value="null" readOnly /></FieldShell>;
  return <FieldShell label={label} required={required} description={description}><Input type="text" value={typeof value === "string" ? value : ""} minLength={typeof schema.minLength === "number" ? schema.minLength : undefined} maxLength={typeof schema.maxLength === "number" ? schema.maxLength : undefined} pattern={typeof schema.pattern === "string" ? schema.pattern : undefined} onChange={(event) => onChange(event.target.value)} /></FieldShell>;
}

function ArrayField({ label, schema, value, required, description, onChange, path, reportJsonValidity }: { label: string; schema: JsonSchema; value: unknown[]; required: boolean; description: string | undefined; onChange: (value: unknown[]) => void; path: string; reportJsonValidity: JsonValidityReporter }) {
  const item = childSchema(schema);
  if (!item) return <JsonValueEditor label={label} value={value} required={required} description={description} path={path} reportJsonValidity={reportJsonValidity} validateParsed={(parsed) => Array.isArray(parsed) ? undefined : "参数必须是 JSON array"} onChange={(next) => { if (Array.isArray(next)) onChange(next); }} />;
  return <fieldset className="m-0 min-w-0 rounded-md border p-2.5"><legend className="px-1.5 text-[11px] font-semibold">{label}{required ? " *" : ""}</legend>{description && <small className="text-xs text-muted-foreground">{description}</small>}
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
function jsonEqual(left: unknown, right: unknown): boolean { try { return JSON.stringify(left) === JSON.stringify(right); } catch { return Object.is(left, right); } }
