import { useState } from "react";
import { Checkbox, Input, Select } from "../../ui";
import { FieldShell, JsonValueEditor } from "./json-editor.js";
import { ArrayField, AdditionalPropertiesField, SchemaFieldset } from "./schema-collections.js";
import {
  initialSchemaValue,
  requiresJsonFallback,
  schemaProperties,
  schemaRequired,
  schemaType,
  type JsonSchema
} from "./schema-form-model.js";
import {
  asObject,
  display,
  isSchema,
  schemaChoices,
  simpleTypeMatches,
  withoutKey,
  type JsonValidityReporter
} from "./schema-form-utils.js";

type FieldProps = {
  label: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  path: string;
  reportJsonValidity: JsonValidityReporter;
  onChange: (value: unknown) => void;
};

export function ObjectFields({ schema, value, onChange, path, reportJsonValidity }: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  path: string;
  reportJsonValidity: JsonValidityReporter;
}) {
  const properties = schemaProperties(schema) ?? {};
  const required = new Set(schemaRequired(schema));
  const extensible = Object.hasOwn(schema, "additionalProperties") && schema.additionalProperties !== false;
  return (
    <div className="grid gap-2.5">
      {Object.entries(properties).map(([name, child]) => {
        const present = Object.hasOwn(value, name);
        const isRequired = required.has(name);
        return (
          <div className="grid gap-1" key={name}>
            {!isRequired && (
              <label className="flex items-center gap-1.5 text-2xs text-fg-3">
                <Checkbox
                  checked={present}
                  onCheckedChange={(checked) =>
                    onChange(checked ? { ...value, [name]: initialSchemaValue(child) } : withoutKey(value, name))
                  }
                />
                <span>设置{typeof child.title === "string" ? child.title : name}（可选）</span>
              </label>
            )}
            {(isRequired || present) && (
              <SchemaField
                label={typeof child.title === "string" ? child.title : name}
                schema={child}
                value={value[name]}
                required={isRequired}
                path={`${path}.${name}`}
                reportJsonValidity={reportJsonValidity}
                onChange={(next) => onChange({ ...value, [name]: next })}
              />
            )}
          </div>
        );
      })}
      {extensible && (
        <AdditionalPropertiesField
          {...(isSchema(schema.additionalProperties) ? { schema: schema.additionalProperties } : {})}
          declared={new Set(Object.keys(properties))}
          value={value}
          onChange={onChange}
          path={path}
          reportJsonValidity={reportJsonValidity}
        />
      )}
      {!Object.keys(properties).length && <small className="text-xs text-fg-3">该工具没有可编辑参数。</small>}
    </div>
  );
}

export function SchemaField(props: FieldProps) {
  const { label, schema, value, required, path, reportJsonValidity, onChange } = props;
  const description = typeof schema.description === "string" ? schema.description : undefined;
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  const type = schemaType(schema);
  const choices = schemaChoices(schema);
  if (choices.length) return <ChoiceSchemaField {...props} choices={choices} />;

  const declaredTypes = Array.isArray(schema.type)
    ? schema.type.filter((item): item is string => typeof item === "string")
    : [];
  if (declaredTypes.includes("null") && declaredTypes.some((item) => item !== "null")) {
    const nonNull = declaredTypes.filter((item) => item !== "null");
    const child = { ...schema, type: nonNull.length === 1 ? nonNull[0] : nonNull };
    return (
      <div className="grid gap-1.5">
        <label className="flex items-center gap-2 text-xs text-fg-2">
          <Checkbox
            checked={value === null}
            onCheckedChange={(checked) => onChange(checked ? null : initialSchemaValue(child))}
          />
          使用空值
        </label>
        {value !== null && <SchemaField {...props} schema={child} />}
      </div>
    );
  }
  const shell = { label, required, description };
  if (Object.hasOwn(schema, "const")) {
    return <FieldShell {...shell}><Input value={display(schema.const)} readOnly /></FieldShell>;
  }
  if (enumValues?.length) {
    return (
      <FieldShell {...shell}>
        <Select
          value={display(value)}
          onChange={(event) => onChange(enumValues.find((item) => display(item) === event.target.value))}
        >
          {enumValues.map((item) => <option key={display(item)} value={display(item)}>{display(item)}</option>)}
        </Select>
      </FieldShell>
    );
  }
  if (requiresJsonFallback(schema)) return <JsonValueEditor {...props} description={description} />;
  if (type === "object") {
    return (
      <SchemaFieldset label={label} required={required} description={description}>
        <ObjectFields
          schema={schema}
          value={asObject(value)}
          onChange={onChange}
          path={path}
          reportJsonValidity={reportJsonValidity}
        />
      </SchemaFieldset>
    );
  }
  if (type === "array") {
    return (
      <ArrayField
        {...props}
        value={Array.isArray(value) ? value : []}
        description={description}
      />
    );
  }
  if (type === "boolean") {
    return (
      <label className="grid content-start gap-1">
        <span className="flex items-center gap-2">
          <Checkbox checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked === true)} />
          <span className="text-xs text-fg-2">{label}{required ? " *" : ""}</span>
        </span>
        {description && <small className="text-xs text-fg-3">{description}</small>}
      </label>
    );
  }
  if (type === "number" || type === "integer") {
    const unit = schema["x-hh-unit"];
    return (
      <FieldShell {...shell}>
        <span className="flex items-center gap-2">
          <Input
            type="number"
            className="tf-num"
            step={type === "integer" ? 1 : "any"}
            value={typeof value === "number" ? value : ""}
            min={typeof schema.minimum === "number" ? schema.minimum : undefined}
            max={typeof schema.maximum === "number" ? schema.maximum : undefined}
            onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
          />
          {typeof unit === "string" && <span className="tf-num text-2xs text-fg-3">{unit}</span>}
        </span>
      </FieldShell>
    );
  }
  if (type === "null") return <FieldShell label={label}><Input value="null" readOnly /></FieldShell>;
  return (
    <FieldShell {...shell}>
      <Input
        type="text"
        value={typeof value === "string" ? value : ""}
        minLength={typeof schema.minLength === "number" ? schema.minLength : undefined}
        maxLength={typeof schema.maxLength === "number" ? schema.maxLength : undefined}
        pattern={typeof schema.pattern === "string" ? schema.pattern : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </FieldShell>
  );
}

function ChoiceSchemaField({ choices, ...props }: FieldProps & { choices: JsonSchema[] }) {
  const { label, value, onChange } = props;
  const initial = Math.max(0, choices.findIndex((choice) => simpleTypeMatches(choice, value)));
  const [selected, setSelected] = useState(initial);
  const choice = choices[selected] ?? choices[0]!;
  return (
    <div className="grid gap-1.5">
      <Select
        aria-label={`${label} 类型`}
        value={selected}
        onChange={(event) => {
          const index = Number(event.target.value);
          setSelected(index);
          onChange(initialSchemaValue(choices[index]!));
        }}
      >
        {choices.map((item, index) => (
          <option key={index} value={index}>
            {typeof item.title === "string" ? item.title : schemaType(item) ?? `选项 ${index + 1}`}
          </option>
        ))}
      </Select>
      <SchemaField {...props} schema={choice} />
    </div>
  );
}
