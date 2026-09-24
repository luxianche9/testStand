import { useEffect, useState } from "react";
import { Textarea } from "../../ui";

/** Raw JSON escape hatch; only valid JSON is emitted. */
export function JsonEditor({ value, onChange, label = "编辑 JSON" }: {
  value: unknown;
  onChange: (value: unknown) => void;
  label?: string;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string>();
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return (
    <details className="rounded-md border border-line bg-surface-0">
      <summary className="cursor-pointer px-2 py-1.5 text-xs text-fg-3 select-none hover:text-fg-2">{label}</summary>
      <div className="grid gap-1 border-t border-line p-2">
        <Textarea
          aria-label={label}
          aria-invalid={error ? true : undefined}
          className="min-h-32 font-mono text-xs"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            try {
              onChange(JSON.parse(event.target.value));
              setError(undefined);
            } catch {
              setError("请输入合法 JSON");
            }
          }}
        />
        {error && <span className="text-xs text-fail">{error}</span>}
      </div>
    </details>
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
