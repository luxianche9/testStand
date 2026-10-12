import { useEffect, useRef, useState, type ReactNode } from "react";
import { Textarea } from "../../ui";
import { isRecord, jsonEqual, pretty, type JsonValidityReporter } from "./schema-form-utils.js";

/** Wrapping `<label>` so the control inside gets the field name as its accessible name. */
export function FieldShell({ label, required, requiredText = "必填", description, error, children, group = false }: {
  label: string;
  required?: boolean;
  requiredText?: string;
  description?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
  /** The field is a group of buttons: a <label> would press the first one when its text is clicked. */
  group?: boolean;
}) {
  const Shell = group ? "div" : "label";
  return (
    <Shell className="grid content-start gap-1">
      <span className="text-xs font-medium text-fg-2">
        {label}
        {required && <i className="tf-label ml-1.5 text-fail not-italic">{requiredText}</i>}
      </span>
      {children}
      {description && <small className="text-xs text-fg-3">{description}</small>}
      {error && <small className="text-xs text-fail">{error}</small>}
    </Shell>
  );
}

export function JsonValueEditor(props: {
  label: string;
  value: unknown;
  required: boolean;
  description: string | undefined;
  path: string;
  reportJsonValidity: JsonValidityReporter;
  validateParsed?: (value: unknown) => string | undefined;
  onChange: (value: unknown) => void;
}) {
  const { label, value, required, description, path, reportJsonValidity, validateParsed, onChange } = props;
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
  const edit = (next: string) => {
    setText(next);
    try {
      const parsed = JSON.parse(next) as unknown;
      const validationError = validateParsed?.(parsed);
      if (validationError) {
        setError(validationError);
        return;
      }
      emittedValue.current = parsed;
      onChange(parsed);
      setError(undefined);
    } catch {
      setError("请输入合法 JSON");
    }
  };
  return (
    <FieldShell label={label} required={required} requiredText="必填 · JSON" description={description} error={error}>
      <Textarea
        className="min-h-8 font-mono text-2xs leading-4"
        rows={Math.min(10, Math.max(2, text.split("\n").length))}
        aria-invalid={error ? true : undefined}
        value={text}
        onChange={(event) => edit(event.target.value)}
      />
    </FieldShell>
  );
}

/** Whole-object JSON editor for experts, shown under the generated form. */
export function AdvancedJson({ value, reportJsonValidity, onChange, open, children }: {
  value: Record<string, unknown>;
  reportJsonValidity: JsonValidityReporter;
  onChange: (value: Record<string, unknown>) => void;
  open?: boolean;
  children?: ReactNode;
}) {
  return (
    <details open={open} className="rounded-md border border-line bg-surface-0/60 px-2.5 py-2">
      <summary className="tf-label cursor-pointer text-fg-3 hover:text-fg-2">编辑 JSON</summary>
      <div className="mt-2">
        {children ?? (
          <ObjectJsonEditor value={value} reportJsonValidity={reportJsonValidity} onChange={onChange} />
        )}
      </div>
    </details>
  );
}

export function ObjectJsonEditor({ value, reportJsonValidity, onChange }: {
  value: Record<string, unknown>;
  reportJsonValidity: JsonValidityReporter;
  onChange: (value: Record<string, unknown>) => void;
}) {
  return (
    <JsonValueEditor
      label="完整值"
      value={value}
      required
      description="专家模式：直接编辑完整对象。"
      path="参数.JSON"
      reportJsonValidity={reportJsonValidity}
      validateParsed={(parsed) => (isRecord(parsed) ? undefined : "必须是 JSON object")}
      onChange={(parsed) => {
        if (isRecord(parsed)) onChange(parsed);
      }}
    />
  );
}

export function SchemaNotice({ tone, children }: { tone: "invalid" | "fail"; children: ReactNode }) {
  return (
    <div
      className={
        tone === "invalid"
          ? "rounded-md border border-invalid/35 bg-invalid/10 px-2.5 py-2 text-xs text-invalid"
          : "rounded-md border border-fail/35 bg-fail/10 px-2.5 py-2 text-xs text-fail"
      }
    >
      {children}
    </div>
  );
}
