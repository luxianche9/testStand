import { useCallback, useEffect, useState } from "react";
import { Select } from "../../ui";
import { AdvancedJson, JsonValueEditor, ObjectJsonEditor, SchemaNotice } from "./json-editor.js";
import { ObjectFields } from "./schema-fields.js";
import {
  initialSchemaValue,
  requiresJsonFallback,
  schemaProperties,
  schemaType,
  type JsonSchema
} from "./schema-form-model.js";
import {
  isRecord,
  schemaChoices,
  simpleTypeMatches,
  withoutKey,
  type JsonValidityReporter
} from "./schema-form-utils.js";

type ArgumentsChange = (value: Record<string, unknown>) => void;

/**
 * Generated argument form for an MCP tool / flow input schema. Falls back to a JSON editor for
 * structures a form cannot represent reliably; `onValidityChange` reports unparsable JSON text.
 */
export function SchemaArgumentsForm({
  schema,
  value,
  onChange,
  onValidityChange,
  preserveHardwareId = false,
  showAdvanced = false
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: ArgumentsChange;
  onValidityChange?: (valid: boolean) => void;
  preserveHardwareId?: boolean;
  showAdvanced?: boolean;
}) {
  const [invalidJsonPaths, setInvalidJsonPaths] = useState<Set<string>>(() => new Set());
  const reportJsonValidity = useCallback<JsonValidityReporter>((path, valid) => {
    setInvalidJsonPaths((current) => {
      if (valid === !current.has(path)) return current;
      const next = new Set(current);
      if (valid) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  useEffect(() => {
    onValidityChange?.(invalidJsonPaths.size === 0);
  }, [invalidJsonPaths, onValidityChange]);

  const rootChoices = schemaChoices(schema);
  if (rootChoices.length) {
    return (
      <RootChoiceForm
        choices={rootChoices}
        value={value}
        onChange={onChange}
        reportJsonValidity={reportJsonValidity}
        showAdvanced={showAdvanced}
      />
    );
  }

  if (requiresJsonFallback(schema)) {
    return (
      <div className="grid gap-2">
        <SchemaNotice tone="invalid">该 Schema 包含无法可靠生成表单的结构，请展开「编辑 JSON」修改。</SchemaNotice>
        <AdvancedJson open value={value} reportJsonValidity={reportJsonValidity} onChange={onChange}>
          <JsonValueEditor
            label="参数"
            value={value}
            required
            description={typeof schema.description === "string" ? schema.description : "使用 JSON 编辑完整工具参数。"}
            path="参数"
            reportJsonValidity={reportJsonValidity}
            validateParsed={(parsed) => (isRecord(parsed) ? undefined : "工具参数必须是 JSON object")}
            onChange={(parsed) => {
              if (!isRecord(parsed)) return;
              onChange(preserveHardwareId ? parsed : withoutKey(parsed, "hardwareId"));
            }}
          />
        </AdvancedJson>
      </div>
    );
  }
  if (schemaType(schema) !== "object" || !schemaProperties(schema)) {
    return <SchemaNotice tone="fail">工具输入 Schema 的根节点必须是 object。</SchemaNotice>;
  }
  return (
    <div className="grid gap-2">
      <ObjectFields
        schema={schema}
        value={value}
        onChange={onChange}
        path="参数"
        reportJsonValidity={reportJsonValidity}
      />
      {showAdvanced && <AdvancedJson value={value} reportJsonValidity={reportJsonValidity} onChange={onChange} />}
    </div>
  );
}

function RootChoiceForm({ choices, value, onChange, reportJsonValidity, showAdvanced }: {
  choices: JsonSchema[];
  value: Record<string, unknown>;
  onChange: ArgumentsChange;
  reportJsonValidity: JsonValidityReporter;
  showAdvanced: boolean;
}) {
  const initial = Math.max(
    0,
    choices.findIndex((choice) => schemaType(choice) === "object" && simpleTypeMatches(choice, value))
  );
  const [selected, setSelected] = useState(initial);
  const choice = choices[selected] ?? choices[0]!;
  if (schemaType(choice) !== "object" || !schemaProperties(choice)) {
    return (
      <div className="grid gap-2">
        <SchemaNotice tone="invalid">所选分支无法可靠生成对象表单，请展开「编辑 JSON」修改。</SchemaNotice>
        <ObjectJsonEditor value={value} reportJsonValidity={reportJsonValidity} onChange={onChange} />
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <Select
        aria-label="Schema 分支"
        value={selected}
        onChange={(event) => {
          const index = Number(event.target.value);
          setSelected(index);
          const next = initialSchemaValue(choices[index]!);
          if (isRecord(next)) onChange(next);
        }}
      >
        <option disabled value="">选择结构</option>
        {choices.map((item, index) => (
          <option key={index} value={index}>{typeof item.title === "string" ? item.title : `选项 ${index + 1}`}</option>
        ))}
      </Select>
      <ObjectFields
        schema={choice}
        value={value}
        onChange={onChange}
        path="参数"
        reportJsonValidity={reportJsonValidity}
      />
      {showAdvanced && <AdvancedJson value={value} reportJsonValidity={reportJsonValidity} onChange={onChange} />}
    </div>
  );
}
