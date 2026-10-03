import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldAlertIcon } from "lucide-react";
import type { TestOperationSnapshot } from "@teststand/contracts/testing";
import { Badge, Button, Dialog, DialogBody, DialogContent, DialogFooter, Field, Input } from "../../ui";
import { invalidateTestingData } from "../../lib/mutations.js";
import { useTestRecoveryItems } from "../../lib/queries.js";
import { operationStateLabel } from "./run-format.js";

type Resolution = "confirmed_succeeded" | "confirmed_failed" | "safe_state_restored";

const resolutions: Array<{ value: Resolution; label: string }> = [
  { value: "confirmed_succeeded", label: "确认已执行" },
  { value: "confirmed_failed", label: "确认未执行" },
  { value: "safe_state_restored", label: "已恢复安全状态" }
];

/** Banner shown above the editor while physical operations still need a human reconcile. */
export function RecoveryBanner({ onOpen }: { onOpen: () => void }) {
  const items = useTestRecoveryItems();
  const count = items.data?.length ?? 0;
  if (!count) return null;
  return (
    <div role="alert" className="flex items-center gap-2 border-b border-fail/40 bg-fail/10 px-3 py-1.5 text-xs">
      <ShieldAlertIcon className="size-4 shrink-0 text-fail" />
      <span className="flex-1 text-fg">{count} 个物理操作结果未知，需要人工确认后才能继续测试。</span>
      <Button size="xs" variant="outline" onClick={onOpen}>处理恢复项</Button>
    </div>
  );
}

/** Lists operations whose outcome is unknown and lets the operator record what physically happened. */
export function RecoveryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const items = useTestRecoveryItems();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const reconcile = async (operation: TestOperationSnapshot, resolution: Resolution) => {
    setBusy(operation.operationId);
    setError(undefined);
    try {
      await window.teststand.testing.reconcileOperation({
        input: { operationId: operation.operationId, resolution, ...(note.trim() ? { note: note.trim() } : {}) }
      });
      await invalidateTestingData(client);
      await items.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };
  const list = items.data ?? [];
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        title={`恢复确认（${list.length}）`}
        description="请到现场确认设备的实际状态，再记录处理结果。"
        size="lg"
      >
        <DialogBody className="grid gap-3">
          <Field label="处理说明" hint="可选，会写入运行记录。">
            <Input value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          {error && <p className="text-xs text-fail">{error}</p>}
          {!list.length && <p className="text-xs text-fg-3">没有待处理的恢复项。</p>}
          {list.map((operation) => (
            <div key={operation.operationId} className="grid gap-2 rounded-sm border border-line bg-surface-0 p-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono text-fg">{operation.hardwareId}</span>
                <span className="font-mono text-fg-2">{operation.toolName}</span>
                <Badge tone="fail">{operationStateLabel(operation.state)}</Badge>
                <code className="ml-auto font-mono text-2xs text-fg-3">{operation.runId.slice(0, 8)}</code>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {resolutions.map((item) => (
                  <Button
                    key={item.value}
                    size="xs"
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() => void reconcile(operation, item.value)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </DialogBody>
        <DialogFooter><Button onClick={onClose}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
