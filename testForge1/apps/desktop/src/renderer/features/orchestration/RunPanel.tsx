import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { OperatorDecision, TestRunDetail, WorkflowVariableDefinition } from "@testforge/contracts/orchestration";
import { IconAlert, IconPlay, IconStop } from "../../shared/icons.js";
import { Badge, Btn, Modal, Spinner } from "../../shared/ui.js";
import { JSON_ERROR, literalText, matchesType, nodeStatusTone, parseLiteral, runTone, tryJson } from "./workflow-model.js";

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

/** Run detail is streamed incrementally: events append from the last id we hold, node runs are
 *  replaced wholesale because their status changes in place. */
export function RunInspector({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<TestRunDetail>();
  const [error, setError] = useState<string>();
  useEffect(() => { setDetail(undefined); setError(undefined); }, [runId]);
  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      const since = detail?.run.runId === runId ? detail.events.at(-1)?.eventId ?? 0 : 0;
      void window.testforge.orchestration.getRun(runId, since, 0, 500)
        .then((delta) => {
          if (cancelled) return;
          setDetail((current) => current && current.run.runId === runId
            ? { run: delta.run, nodeRuns: delta.nodeRuns, events: [...current.events, ...delta.events] }
            : delta);
        })
        .catch((value) => { if (!cancelled) setError(String(value)); });
    };
    pull();
    const stopRun = window.testforge.events.subscribe("run", pull);
    const stopNode = window.testforge.events.subscribe("nodeRun", pull);
    const fallback = window.setInterval(pull, 10_000);
    return () => { cancelled = true; stopRun(); stopNode(); window.clearInterval(fallback); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, detail?.events.at(-1)?.eventId]);

  const cancel = useMutation({ mutationFn: () => window.testforge.orchestration.cancelRun(runId) });
  if (error) return <div className="inspector-content"><div className="alert"><IconAlert size={15} /><span>{error}</span></div></div>;
  if (!detail) return <div className="inspector-content"><Spinner label="正在加载运行记录…" /></div>;

  const counts = {
    passed: detail.nodeRuns.filter((item) => item.status === "passed").length,
    failed: detail.nodeRuns.filter((item) => item.status === "failed").length,
    cancelled: detail.nodeRuns.filter((item) => item.status === "cancelled").length
  };
  return <div className="inspector-content run-inspector">
    <header><strong>Run {detail.run.runId.slice(0, 8)}</strong><Badge tone={runTone(detail.run.status)}>{detail.run.status}</Badge></header>
    {["running", "cancelling"].includes(detail.run.status) && <Btn variant="danger" icon={<IconStop size={13} />} disabled={cancel.isPending} onClick={() => cancel.mutate()}>取消运行</Btn>}
    {detail.run.summary?.message && <p className="muted-copy">{detail.run.summary.message}</p>}
    <div className="run-summary">
      <span>通过 <strong>{detail.run.summary?.passedNodes ?? counts.passed}</strong></span>
      <span>失败 <strong>{detail.run.summary?.failedNodes ?? counts.failed}</strong></span>
      <span>取消 <strong>{detail.run.summary?.cancelledNodes ?? counts.cancelled}</strong></span>
    </div>
    {detail.run.validationIssues?.length ? <div className="validation-box invalid">
      <strong>预检未通过</strong>
      {detail.run.validationIssues.map((issue, index) => <div key={index}><code>{issue.code}</code><span>{issue.message}</span></div>)}
    </div> : null}
    <div className="node-run-list">
      {[...detail.nodeRuns].reverse().map((node) => <article key={node.nodeRunId}>
        <Badge tone={nodeStatusTone(node.status)}>{node.status}</Badge>
        <span>
          <strong>{node.nodeLabel}</strong>
          <small>{node.branchPath}{node.iterationPath.length ? ` · 迭代 ${node.iterationPath.join("/")}` : ""}{node.attempt > 1 ? ` · 第 ${node.attempt} 次尝试` : ""}</small>
          {node.error && <em>{node.error.message}</em>}
        </span>
      </article>)}
      {!detail.nodeRuns.length && <small className="muted-copy">尚无节点记录</small>}
    </div>
    <small className="muted-copy">已接收 {detail.events.length} 条增量事件</small>
  </div>;
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
