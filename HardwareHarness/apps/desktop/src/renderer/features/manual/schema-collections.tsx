import { useState, type ReactNode } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button, IconButton, Input } from "../../ui";
import { JsonValueEditor } from "./json-editor.js";
import { SchemaField } from "./schema-fields.js";
import { childSchema, initialSchemaValue, type JsonSchema } from "./schema-form-model.js";
import { withoutKey, type JsonValidityReporter } from "./schema-form-utils.js";

/** Nested group (object / array) with a small instrument-style legend. */
export function SchemaFieldset({ label, required, description, children }: {
  label: string;
  required: boolean;
  description: string | undefined;
  children: ReactNode;
}) {
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 rounded-md border border-line bg-surface-0/60 px-2.5 pt-1 pb-2.5">
      <legend className="tf-label px-1 text-fg-2">{label}{required ? " *" : ""}</legend>
      {description && <small className="text-xs text-fg-3">{description}</small>}
      {children}
    </fieldset>
  );
}

export function ArrayField({ label, schema, value, required, description, onChange, path, reportJsonValidity }: {
  label: string;
  schema: JsonSchema;
  value: unknown[];
  required: boolean;
  description: string | undefined;
  onChange: (value: unknown[]) => void;
  path: string;
  reportJsonValidity: JsonValidityReporter;
}) {
  const item = childSchema(schema);
  if (!item) {
    return (
      <JsonValueEditor
        label={label}
        value={value}
        required={required}
        description={description}
        path={path}
        reportJsonValidity={reportJsonValidity}
        validateParsed={(parsed) => (Array.isArray(parsed) ? undefined : "参数必须是 JSON array")}
        onChange={(next) => {
          if (Array.isArray(next)) onChange(next);
        }}
      />
    );
  }
  return (
    <SchemaFieldset label={label} required={required} description={description}>
      {value.map((entry, index) => (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2" key={index}>
          <SchemaField
            label={`#${index + 1}`}
            schema={item}
            value={entry}
            required
            path={`${path}.${index}`}
            reportJsonValidity={reportJsonValidity}
            onChange={(next) => onChange(value.map((current, itemIndex) => (itemIndex === index ? next : current)))}
          />
          <IconButton
            label={`删除 ${label} 第 ${index + 1} 项`}
            size="icon-sm"
            onClick={() => onChange(value.filter((_entry, itemIndex) => itemIndex !== index))}
          >
            <Trash2Icon />
          </IconButton>
        </div>
      ))}
      <Button
        variant="outline"
        size="xs"
        className="justify-self-start"
        onClick={() => onChange([...value, initialSchemaValue(item)])}
      >
        <PlusIcon />新增一项
      </Button>
    </SchemaFieldset>
  );
}

export function AdditionalPropertiesField({ schema, declared, value, onChange, path, reportJsonValidity }: {
  schema?: JsonSchema;
  declared: Set<string>;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  path: string;
  reportJsonValidity: JsonValidityReporter;
}) {
  const entries = Object.entries(value).filter(([name]) => !declared.has(name));
  const [newKey, setNewKey] = useState("");
  const trimmed = newKey.trim();
  const add = () => {
    if (!trimmed || Object.hasOwn(value, trimmed)) return;
    onChange({ ...value, [trimmed]: schema ? initialSchemaValue(schema) : "" });
    setNewKey("");
  };
  const rename = (name: string, entry: unknown, raw: string) => {
    const nextName = raw.trim();
    if (!nextName || nextName === name || Object.hasOwn(value, nextName)) return;
    onChange({ ...withoutKey(value, name), [nextName]: entry });
  };
  return (
    <SchemaFieldset label="扩展键值" required={false} description={undefined}>
      {entries.map(([name, entry]) => (
        <div key={name} className="grid grid-cols-[120px_minmax(0,1fr)_auto] items-end gap-2">
          <Input
            className="font-mono text-xs"
            aria-label={`${name} 键名`}
            value={name}
            onChange={(event) => rename(name, entry, event.target.value)}
          />
          {schema ? (
            <SchemaField
              label={name}
              schema={schema}
              value={entry}
              required
              path={`${path}.${name}`}
              reportJsonValidity={reportJsonValidity}
              onChange={(next) => onChange({ ...value, [name]: next })}
            />
          ) : (
            <JsonValueEditor
              label={name}
              value={entry}
              required={false}
              description="任意 JSON 值"
              path={`${path}.${name}`}
              reportJsonValidity={reportJsonValidity}
              onChange={(next) => onChange({ ...value, [name]: next })}
            />
          )}
          <IconButton label={`删除 ${name}`} size="icon-sm" onClick={() => onChange(withoutKey(value, name))}>
            <Trash2Icon />
          </IconButton>
        </div>
      ))}
      <div className="flex gap-2">
        <Input
          className="font-mono text-xs"
          aria-label="新增扩展键"
          value={newKey}
          placeholder="键名"
          onChange={(event) => setNewKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        <Button variant="outline" size="sm" disabled={!trimmed || Object.hasOwn(value, trimmed)} onClick={add}>
          <PlusIcon />增加键
        </Button>
      </div>
    </SchemaFieldset>
  );
}
