import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ManualCheckRequest, ManualVerdict } from "@teststand/contracts/testing";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import { useCurrentTestRun } from "../../lib/queries.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Field, Input, Textarea, useToast } from "../../ui";

const OPERATOR_KEY = "teststand.manualCheck.operator";
const variants: Record<ManualVerdict, "primary" | "danger" | "outline"> = {
  pass: "primary",
  fail: "danger",
  inconclusive: "outline"
};

/** Only images the renderer can show by itself; project paths are listed as text. */
export function displayableImage(source: string): boolean {
  return /^(?:https?:|data:image\/)/i.test(source);
}

/**
 * ManualCheck (design §7.2): the run waits until the operator picks an answer, which becomes M-grade
 * evidence. Shown over any page; the run snapshot is refetched on `testRun` events.
 */
export function ManualCheckDialog() {
  const run = useCurrentTestRun();
  const pending = run.data?.state === "completed" ? [] : run.data?.manualChecks ?? [];
  const current = pending[0];
  if (!run.data || !current) return null;
  return (
    <ManualCheckForm
      key={current.executionId}
      runId={run.data.runId}
      request={current}
      waiting={pending.length - 1}
    />
  );
}

function ManualCheckForm({ runId, request, waiting }: {
  runId: string;
  request: ManualCheckRequest;
  waiting: number;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [operator, setOperator] = useState(() => localStorage.getItem(OPERATOR_KEY) ?? "");
  const [remaining, setRemaining] = useState<number>();
  useEffect(() => {
    if (!request.timeoutMs) return;
    const deadline = Date.parse(request.requestedAt) + request.timeoutMs;
    const tick = () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [request.requestedAt, request.timeoutMs]);
  const answer = useMutation({
    mutationFn: (option: string) => {
      const name = operator.trim();
      if (name) localStorage.setItem(OPERATOR_KEY, name);
      return window.teststand.testing.answerManualCheck({
        input: {
          runId, executionId: request.executionId, option,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(name ? { operator: name } : {})
        }
      });
    },
    onError: (reason) => toast.error(errorMessage(reason)),
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.testRun })
  });
  const noteMissing = request.requireNote && !note.trim();
  const images = request.images ?? [];

  return (
    <Dialog open>
      <DialogContent
        title={`人工判定：${request.name}`}
        description={[
          waiting > 0 ? `还有 ${waiting} 项等待判定` : "",
          remaining !== undefined ? `${remaining} 秒后记为无法判断` : ""
        ].filter(Boolean).join("　") || undefined}
        size="md"
        closable={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogBody className="grid gap-3">
          <p className="whitespace-pre-wrap text-sm text-fg">{request.prompt}</p>
          {images.length > 0 && (
            <div className="grid gap-1.5">
              {images.map((source) => displayableImage(source)
                ? <img key={source} src={source} alt="参考图片" className="max-h-56 rounded-sm border border-line" />
                : <code key={source} className="font-mono text-2xs text-fg-3">{source}</code>)}
            </div>
          )}
          <Field label="说明" required={request.requireNote} error={noteMissing ? "此项判定必须填写说明" : undefined}>
            <Textarea aria-label="判定说明" value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <Field label="判定人" hint="留空时记录本机登录名。">
            <Input aria-label="判定人" value={operator} onChange={(event) => setOperator(event.target.value)} />
          </Field>
        </DialogBody>
        <DialogFooter>
          {request.options.map((option) => (
            <Button
              key={option.label}
              variant={variants[option.verdict]}
              disabled={answer.isPending || noteMissing}
              onClick={() => answer.mutate(option.label)}
            >
              {option.label}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
