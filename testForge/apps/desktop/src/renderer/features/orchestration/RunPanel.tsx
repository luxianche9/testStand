import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { OperatorDecision, WorkflowVariableDefinition } from "@testforge/contracts/orchestration";
import { IconAlert, IconPlay } from "../../shared/icons.js";
import { Badge, Btn, Modal } from "../../shared/ui.js";
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
  return <Modal
    open={open}
    onClose={onClose}
    title="运行输入"
    width={620}
    footer={<>
      <Btn onClick={onClose}>取消</Btn>
      <Btn variant="primary" icon={<IconPlay size={13} />} disabled={pending || parsed.errors.length > 0} onClick={() => onRun(parsed.values)}>开始运行</Btn>
    </>}
  >
    <div className="form-grid">
      {inputs.map((input) => <label className="field span-2" key={input.name}>
        <span className="field-label">{input.name}<i>{input.type}</i></span>
        <input className="input" value={text[input.name] ?? ""} onChange={(event) => setText((current) => ({ ...current, [input.name]: event.target.value }))} placeholder={input.type === "object" || input.type === "array" ? "JSON" : input.type} />
        {input.description && <small className="muted-copy">{input.description}</small>}
      </label>)}
      {parsed.errors.length > 0 && <div className="alert span-2"><IconAlert size={15} /><span>{parsed.errors.join("；")}</span></div>}
    </div>
  </Modal>;
}

export function OperatorDecisionModal({ decision, onResponded }: { decision?: OperatorDecision | undefined; onResponded: () => void }) {
  const respond = useMutation({
    mutationFn: (value: string) => window.testforge.orchestration.respondOperatorDecision(decision!.nodeRunId, value),
    onSuccess: onResponded
  });
  if (!decision) return null;
  return <Modal open onClose={() => undefined} title="测试运行等待操作员判断" width={660}>
    <div className="operator-decision">
      <Badge tone="warn">阻塞执行</Badge>
      <h3>{decision.prompt}</h3>
      <div>{decision.options.map((option) => <Btn key={String(option.value)} variant="primary" disabled={respond.isPending} onClick={() => respond.mutate(String(option.value))}>{option.label}</Btn>)}</div>
      {respond.isError && <div className="alert"><IconAlert size={15} /><span>{String(respond.error)}</span></div>}
      <small className="muted-copy">该确认只属于当前 Run；应用关闭后 Run 会被标记为 interrupted。</small>
    </div>
  </Modal>;
}
