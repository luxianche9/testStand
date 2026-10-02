import { useEffect, useState } from "react";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Field, Input } from "../../ui";

/** Single text-field dialog used for 功能测试项 names. */
function TextPromptDialog({ open, title, label, initial = "", placeholder, submitLabel, hint, allowEmpty,
  onCancel, onSubmit }: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  submitLabel: string;
  hint?: React.ReactNode;
  /** When true an empty value is accepted (the backend picks a default). */
  allowEmpty?: boolean;
  onCancel: () => void;
  onSubmit: (value: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setValue(initial); setError(undefined); setBusy(false); }
  }, [initial, open]);
  const trimmed = value.trim();
  const submit = async () => {
    if (!trimmed && !allowEmpty) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent title={title} size="sm">
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <DialogBody>
            <Field label={label} error={error} hint={hint}>
              <Input
                autoFocus
                value={value}
                placeholder={placeholder}
                onChange={(event) => setValue(event.target.value)}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={onCancel}>取消</Button>
            <Button type="submit" variant="primary" disabled={busy || (!trimmed && !allowEmpty)}>{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type ItemPrompt =
  | { kind: "create"; name: string }
  | { kind: "rename"; planId: string; name: string };

/** Renders the prompt dialog for whichever item-list action is pending. */
export function ItemPromptDialog({ prompt, onClose, onCreate, onRename }: {
  prompt: ItemPrompt | undefined;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (planId: string, name: string) => Promise<void>;
}) {
  if (prompt?.kind === "create") {
    return (
      <TextPromptDialog
        open
        title="新建功能测试项"
        label="名称"
        initial={prompt.name}
        submitLabel="创建"
        onCancel={onClose}
        onSubmit={onCreate}
      />
    );
  }
  if (prompt?.kind === "rename") {
    return (
      <TextPromptDialog
        open
        title="重命名功能测试项"
        label="名称"
        initial={prompt.name}
        submitLabel="重命名"
        onCancel={onClose}
        onSubmit={(name) => onRename(prompt.planId, name)}
      />
    );
  }
  return null;
}
