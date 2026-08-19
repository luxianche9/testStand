import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CircleAlertIcon, PlayIcon } from "lucide-react";
import type { OperatorDecision, WorkflowVariableDefinition } from "@testforge/contracts/orchestration";
import { errorMessage } from "../../shared/errors.js";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../../shared/ui/dialog";
import { Input } from "../../shared/ui/input";
import { JSON_ERROR, literalText, matchesType, parseLiteral, tryJson } from "./workflow-model.js";

export function RunInputsModal({ open, inputs, pending, onClose, onRun }: {
  open: boolean; inputs: WorkflowVariableDefinition[]; pending: boolean; onClose: () => void; onRun: (values: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setText(Object.fromEntries(inputs.map((input) => [input.name, input.defaultValue === undefined ? "" : literalText(input.defaultValue)])));
  }, [inputs, open]);
  const parsed = useMemo(() => {
    const values: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const input of inputs) {
      const raw = text[input.name] ?? "";
      if (raw.trim() === "") { errors.push(`${input.name} 未填写`); continue; }
      const value = input.type === "object" || input.type === "array" ? tryJson(raw) : parseLiteral(raw);
      if (value === JSON_ERROR) { errors.push(`${input.name} 不是合法 JSON`); continue; }
      if (!matchesType(value, input.type)) { errors.push(`${input.name} 必须是 ${input.type}`); continue; }
      values[input.name] = value;
    }
    return { values, errors };
  }, [inputs, text]);
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent className="w-[620px]">
      <DialogHeader title="运行输入" onClose={onClose} />
      <DialogBody>
        <div className="grid grid-cols-2 gap-x-3.5 gap-y-3">
          {inputs.map((input) => <label className="col-span-2 grid content-start gap-1.5" key={input.name}>
            <span className="text-xs text-muted-foreground">{input.name}<i className="ml-0.5 text-destructive not-italic">{input.type}</i></span>
            <Input value={text[input.name] ?? ""} onChange={(event) => setText((current) => ({ ...current, [input.name]: event.target.value }))} placeholder={input.type === "object" || input.type === "array" ? "JSON" : input.type} />
            {input.description && <small className="text-xs text-muted-foreground">{input.description}</small>}
          </label>)}
          {parsed.errors.length > 0 && <div className="col-span-2 flex items-center gap-1.5 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-xs text-destructive"><CircleAlertIcon className="size-4 shrink-0" /><span>{parsed.errors.join("；")}</span></div>}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button disabled={pending || parsed.errors.length > 0} onClick={() => onRun(parsed.values)}><PlayIcon className="size-3.5" />开始运行</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function OperatorDecisionModal({ decision, onResponded }: { decision?: OperatorDecision | undefined; onResponded: () => void }) {
  const respond = useMutation({
    mutationFn: (value: string) => window.testforge.orchestration.respondOperatorDecision(decision!.nodeRunId, value),
    onSuccess: onResponded
  });
  if (!decision) return null;
  return <Dialog open onOpenChange={() => undefined}>
    <DialogContent className="w-[660px]">
      <DialogHeader title="测试运行等待操作员判断" />
      <DialogBody>
        <div className="flex flex-col items-start gap-3.5">
          <Badge variant="warning">阻塞执行</Badge>
          <h3 className="m-0 text-base font-semibold">{decision.prompt}</h3>
          <div className="flex flex-wrap gap-2">{decision.options.map((option) => <Button key={String(option.value)} disabled={respond.isPending} onClick={() => respond.mutate(String(option.value))}>{option.label}</Button>)}</div>
          {respond.isError && <div className="flex items-center gap-1.5 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-xs text-destructive"><CircleAlertIcon className="size-4 shrink-0" /><span>{errorMessage(respond.error)}</span></div>}
          <small className="text-xs text-muted-foreground">该确认只属于当前 Run；应用关闭后 Run 会被标记为 interrupted。</small>
        </div>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
