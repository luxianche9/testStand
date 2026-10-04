import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ToolCatalogItem } from "@teststand/contracts/devices";
import { PlayIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import { Badge, Button, Dialog, DialogBody, DialogContent, DialogFooter, Spinner } from "../../ui";
import { InvocationResult, type InvocationOutcome } from "../manual/InvocationResult.js";
import { SchemaArgumentsForm } from "../manual/SchemaForm.js";
import { initialSchemaValue } from "../manual/schema-form-model.js";
import { validateSchemaArguments } from "../manual/schema-validation.js";
import { actionKind } from "./device-actions.js";

const TIMEOUT_MS = 30_000;

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * One device action: its parameters as a form, then 确认执行 runs it once and shows the result.
 * The dialog stays open so the same action can be repeated or its parameters changed.
 */
export function ActionDialog({ action, title, deviceLabel, hardwareId, available, onClose }: {
  action: ToolCatalogItem | undefined;
  title: string;
  deviceLabel: string;
  hardwareId: string;
  available: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={Boolean(action)} onOpenChange={(open) => { if (!open) onClose(); }}>
      {action && (
        <DialogContent title={`${deviceLabel} · ${title}`} size="md">
          <ActionForm key={action.externalName} action={action} hardwareId={hardwareId} available={available}
            onClose={onClose} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function ActionForm({ action, hardwareId, available, onClose }: {
  action: ToolCatalogItem;
  hardwareId: string;
  available: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [values, setValues] = useState(() => asObject(initialSchemaValue(action.inputSchema)));
  const [formValid, setFormValid] = useState(true);
  const [outcome, setOutcome] = useState<InvocationOutcome>();
  const started = useRef(0);
  const validation = useMemo(() => validateSchemaArguments(action.inputSchema, values), [action.inputSchema, values]);
  const kind = actionKind(action);
  const hasFields = Object.keys(asObject(action.inputSchema.properties)).length > 0;

  const run = useMutation({
    mutationFn: () => {
      started.current = performance.now();
      setOutcome(undefined);
      return window.teststand.manual.invokeTool({
        raw: { hardwareId, toolName: action.externalName, arguments: values, timeoutMs: TIMEOUT_MS }
      });
    },
    onSuccess: (result) => setOutcome({ kind: "success", result }),
    onError: (error) => setOutcome({
      kind: "failure",
      message: errorMessage(error),
      durationMs: Math.max(0, Math.round(performance.now() - started.current))
    }),
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.dashboard })
  });

  return (
    <>
      <DialogBody className="grid gap-3">
        <div className="flex items-start gap-2">
          <Badge tone={kind.tone}>{kind.label}</Badge>
          {action.description && <p className="text-xs break-words text-fg-2">{action.description}</p>}
        </div>
        {hasFields ? (
          <SchemaArgumentsForm schema={action.inputSchema} value={values} onChange={setValues}
            onValidityChange={setFormValid} />
        ) : (
          <p className="text-xs text-fg-3">该动作没有参数。</p>
        )}
        {validation.errors.length > 0 && (
          <ul className="grid gap-1 rounded-md border border-invalid/40 bg-invalid/10 px-2.5 py-2 text-xs text-fg-2">
            {validation.errors.map((message, index) => <li key={index}>{message}</li>)}
          </ul>
        )}
        {!available && <p role="alert" className="text-xs text-fail">设备当前不在线，恢复在线后才能执行。</p>}
        {outcome && <InvocationResult outcome={outcome} />}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>关闭</Button>
        <Button
          variant="primary"
          disabled={!available || !formValid || !validation.valid || run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending ? <Spinner /> : <PlayIcon />}
          {run.isPending ? "正在执行…" : "确认执行"}
        </Button>
      </DialogFooter>
    </>
  );
}
