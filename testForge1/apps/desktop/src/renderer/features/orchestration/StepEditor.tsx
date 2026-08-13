import { useState, type ReactNode } from "react";
import type { ToolCatalogItem } from "@testforge/contracts/devices";
import type { TestStep, TestTask, WorkflowExpression, WorkflowValueTemplate, WorkflowVariableDefinition } from "@testforge/contracts/orchestration";
import { IconCopy, IconPlus, IconTrash } from "../../shared/icons.js";
import { Btn } from "../../shared/ui.js";
import { STEP_TYPES, literalText, newExpression, newStep, newValueTemplate, parseLiteral, stepTypeLabel } from "./workflow-model.js";

export function VariableEditor({ task, onChange }: { task: TestTask; onChange: (task: TestTask) => void }) {
  const [tab, setTab] = useState<"inputs" | "variables">("variables");
  const values = task[tab];
  const update = (index: number, value: WorkflowVariableDefinition) =>
    onChange({ ...task, [tab]: values.map((item, itemIndex) => itemIndex === index ? value : item) });
  return <div className="variable-editor">
    <div className="variable-editor-head">
      <div className="view-switch" role="group" aria-label="变量类别">
        <button className={tab === "inputs" ? "active" : ""} onClick={() => setTab("inputs")}>输入 {task.inputs.length}</button>
        <button className={tab === "variables" ? "active" : ""} onClick={() => setTab("variables")}>变量 {task.variables.length}</button>
      </div>
      <Btn icon={<IconPlus size={13} />} onClick={() => onChange({ ...task, [tab]: [...values, { name: `${tab === "inputs" ? "input" : "value"}_${values.length + 1}`, type: "unknown" }] })}>新增</Btn>
    </div>
    {values.map((item, index) => <div className="variable-row" key={`${tab}-${index}`}>
      <input className="input" value={item.name} onChange={(event) => update(index, { ...item, name: event.target.value })} aria-label="变量名" />
      <select className="input" value={item.type} onChange={(event) => update(index, { ...item, type: event.target.value as WorkflowVariableDefinition["type"] })}>
        {["string", "number", "boolean", "object", "array", "unknown"].map((type) => <option key={type}>{type}</option>)}
      </select>
      <Btn variant="subtle" onClick={() => onChange({ ...task, [tab]: values.filter((_item, itemIndex) => itemIndex !== index) })}>×</Btn>
    </div>)}
    {!values.length && <small className="muted-copy">{tab === "inputs" ? "输入在启动 Run 时赋值，步骤内只读。" : "变量只能由步骤写入，且必须先在这里声明。"}</small>}
  </div>;
}

export function StepProperties({ step, task, tools, onChange, onDelete, onDuplicate }: {
  step: TestStep;
  task: TestTask;
  tools: ToolCatalogItem[];
  onChange: (step: TestStep) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const variables = [...task.inputs, ...task.variables];
  const writable = task.variables;
  let fields: ReactNode = null;

  if (step.type === "set_variable") fields = <>
    <VariableSelect label="写入变量" value={step.variable} variables={writable} onChange={(variable) => onChange({ ...step, variable })} />
    <ValueTemplateEditor label="值" value={step.value} variables={variables} onChange={(value) => onChange({ ...step, value })} />
  </>;
  else if (step.type === "delay") fields = <ValueTemplateEditor label="时长 ms" value={step.durationMs} variables={variables} onChange={(durationMs) => onChange({ ...step, durationMs })} />;
  else if (step.type === "assert") fields = <>
    <ExpressionEditor label="断言表达式" value={step.expression} variables={variables} onChange={(expression) => onChange({ ...step, expression })} />
    <label className="field"><span className="field-label">失败消息</span><input className="input" value={step.message} onChange={(event) => onChange({ ...step, message: event.target.value })} /></label>
  </>;
  else if (step.type === "if") fields = <>
    <ExpressionEditor label="条件" value={step.condition} variables={variables} onChange={(condition) => onChange({ ...step, condition })} />
    <NestedAdd label="向 Then 添加步骤" onAdd={(value) => onChange({ ...step, then: [...step.then, value] })} />
    <NestedAdd label="向 Else 添加步骤" onAdd={(value) => onChange({ ...step, else: [...step.else, value] })} />
  </>;
  else if (step.type === "loop") fields = <>
    <label className="field"><span className="field-label">模式</span>
      <select className="input" value={step.mode} onChange={(event) => onChange({ ...step, mode: event.target.value as "count" | "while" })}>
        <option value="count">count（固定次数）</option>
        <option value="while">while（条件为真）</option>
      </select>
    </label>
    {step.mode === "count"
      ? <ValueTemplateEditor label="次数" value={step.count ?? { kind: "literal", value: 1 }} variables={variables} onChange={(count) => onChange({ ...step, count })} />
      : <ExpressionEditor label="循环条件" value={step.condition ?? { kind: "literal", value: true }} variables={variables} onChange={(condition) => onChange({ ...step, condition })} />}
    <label className="field"><span className="field-label">最大次数</span><input className="input" type="number" value={step.maxIterations} onChange={(event) => onChange({ ...step, maxIterations: Number(event.target.value) })} /></label>
    <VariableSelect label="迭代序号写入" value={step.indexVariable} variables={writable.filter((item) => item.type === "number" || item.type === "unknown")} onChange={(indexVariable) => onChange({ ...step, indexVariable })} />
    <NestedAdd label="向 Body 添加步骤" onAdd={(value) => onChange({ ...step, body: [...step.body, value] })} />
  </>;
  else if (step.type === "parallel") fields = <>
    {step.branches.map((branch, index) => <div className="nested-box" key={branch.branchId}>
      <input className="input" value={branch.name} onChange={(event) => onChange({ ...step, branches: step.branches.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} />
      <NestedAdd label="添加步骤" onAdd={(value) => onChange({ ...step, branches: step.branches.map((item, itemIndex) => itemIndex === index ? { ...item, steps: [...item.steps, value] } : item) })} />
    </div>)}
    <Btn icon={<IconPlus size={13} />} onClick={() => onChange({ ...step, branches: [...step.branches, { branchId: crypto.randomUUID(), name: `Branch ${String.fromCharCode(65 + step.branches.length)}`, steps: [] }] })}>新增分支</Btn>
    <small className="muted-copy">并行分支不能写入同一个变量，校验会报 parallel_shared_write。</small>
  </>;
  else if (step.type === "operator") fields = <>
    <label className="field"><span className="field-label">提示语</span><input className="input" value={step.prompt} onChange={(event) => onChange({ ...step, prompt: event.target.value })} /></label>
    <VariableSelect allowEmpty label="选择结果写入" value={step.resultVariable ?? ""} variables={writable} onChange={(resultVariable) => {
      if (resultVariable) onChange({ ...step, resultVariable });
      else { const { resultVariable: _dropped, ...rest } = step; onChange(rest); }
    }} />
    <div className="nested-box">
      <strong>可选项</strong>
      {step.options.map((option, index) => <div className="variable-row" key={index}>
        <input className="input" value={option.label} placeholder="显示文字" onChange={(event) => onChange({ ...step, options: step.options.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) })} />
        <input className="input" value={String(option.value)} placeholder="值" onChange={(event) => onChange({ ...step, options: step.options.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item) })} />
        <Btn variant="subtle" onClick={() => onChange({ ...step, options: step.options.filter((_item, itemIndex) => itemIndex !== index) })}>×</Btn>
      </div>)}
      <Btn icon={<IconPlus size={13} />} onClick={() => onChange({ ...step, options: [...step.options, { label: "继续", value: "continue" }] })}>新增选项</Btn>
    </div>
  </>;
  else if (step.type === "tool") fields = <>
    <label className="field"><span className="field-label">硬件工具</span>
      <select className="input" value={step.toolName} onChange={(event) => onChange({ ...step, toolName: event.target.value })}>
        <option value="">选择工具</option>
        {tools.filter((tool) => tool.kind === "hardware").map((tool) => <option key={tool.externalName} value={tool.externalName}>{tool.externalName}</option>)}
      </select>
    </label>
    <label className="field"><span className="field-label">Hardware ID</span><input className="input" value={step.hardwareId} onChange={(event) => onChange({ ...step, hardwareId: event.target.value })} /></label>
    <label className="field"><span className="field-label">超时 ms</span><input className="input" type="number" value={step.timeoutMs} onChange={(event) => onChange({ ...step, timeoutMs: Number(event.target.value) })} /></label>
    <div className="variable-row">
      <label className="field"><span className="field-label">重试次数</span><input className="input" type="number" value={step.retry.maxAttempts} onChange={(event) => onChange({ ...step, retry: { ...step.retry, maxAttempts: Number(event.target.value) } })} /></label>
      <label className="field"><span className="field-label">重试间隔 ms</span><input className="input" type="number" value={step.retry.delayMs} onChange={(event) => onChange({ ...step, retry: { ...step.retry, delayMs: Number(event.target.value) } })} /></label>
    </div>
    <div className="nested-box">
      <strong>调用参数</strong>
      {Object.entries(step.arguments).map(([name, value]) => <div className="nested-box" key={name}>
        <div className="variable-row">
          <input className="input" value={name} readOnly aria-label="参数名" />
          <Btn variant="subtle" onClick={() => { const { [name]: _dropped, ...rest } = step.arguments; onChange({ ...step, arguments: rest }); }}>×</Btn>
        </div>
        <ValueTemplateEditor value={value} variables={variables} onChange={(next) => onChange({ ...step, arguments: { ...step.arguments, [name]: next } })} />
      </div>)}
      <ArgumentAdder existing={Object.keys(step.arguments)} onAdd={(name) => onChange({ ...step, arguments: { ...step.arguments, [name]: { kind: "literal", value: "" } } })} />
    </div>
    <div className="nested-box">
      <strong>输出绑定</strong>
      {step.outputBindings.map((binding, index) => <div className="variable-row" key={index}>
        <VariableSelect label="变量" value={binding.variable} variables={writable} onChange={(variable) => onChange({ ...step, outputBindings: step.outputBindings.map((item, itemIndex) => itemIndex === index ? { ...item, variable } : item) })} />
        <label className="field"><span className="field-label">JSON Pointer</span><input className="input" value={binding.pointer} placeholder="/value" onChange={(event) => onChange({ ...step, outputBindings: step.outputBindings.map((item, itemIndex) => itemIndex === index ? { ...item, pointer: event.target.value } : item) })} /></label>
        <Btn variant="subtle" onClick={() => onChange({ ...step, outputBindings: step.outputBindings.filter((_item, itemIndex) => itemIndex !== index) })}>×</Btn>
      </div>)}
      <Btn icon={<IconPlus size={13} />} onClick={() => onChange({ ...step, outputBindings: [...step.outputBindings, { variable: writable[0]?.name ?? "", pointer: "" }] })}>新增绑定</Btn>
    </div>
  </>;

  return <div className="inspector-content">
    <label className="field"><span className="field-label">名称</span><input className="input" value={step.label} onChange={(event) => onChange({ ...step, label: event.target.value })} /></label>
    <label className="field check"><input type="checkbox" checked={step.enabled} onChange={(event) => onChange({ ...step, enabled: event.target.checked })} /><span>启用该步骤</span></label>
    {fields}
    <footer className="inspector-actions">
      <Btn icon={<IconCopy size={13} />} onClick={onDuplicate}>复制</Btn>
      <Btn variant="danger" icon={<IconTrash size={13} />} onClick={onDelete}>删除</Btn>
    </footer>
  </div>;
}

function ArgumentAdder({ existing, onAdd }: { existing: string[]; onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  const invalid = !name.trim() || existing.includes(name.trim());
  return <div className="variable-row">
    <input className="input" value={name} placeholder="参数名" onChange={(event) => setName(event.target.value)} />
    <Btn disabled={invalid} onClick={() => { onAdd(name.trim()); setName(""); }}>新增参数</Btn>
  </div>;
}

function VariableSelect({ label = "变量", value, variables, onChange, allowEmpty = false }: {
  label?: string; value: string; variables: WorkflowVariableDefinition[]; onChange: (value: string) => void; allowEmpty?: boolean;
}) {
  return <label className="field">
    <span className="field-label">{label}</span>
    <select className="input" value={value} onChange={(event) => onChange(event.target.value)}>
      {allowEmpty && <option value="">不绑定</option>}
      {!allowEmpty && !value && <option value="">选择变量</option>}
      {variables.map((item) => <option key={item.name} value={item.name}>{item.name}（{item.type}）</option>)}
    </select>
  </label>;
}

function ValueTemplateEditor({ label, value, variables, onChange }: {
  label?: string; value: WorkflowValueTemplate; variables: WorkflowVariableDefinition[]; onChange: (value: WorkflowValueTemplate) => void;
}) {
  return <div className="expression-box">
    {label && <span className="field-label">{label}</span>}
    <select className="input" value={value.kind} onChange={(event) => onChange(newValueTemplate(event.target.value as WorkflowValueTemplate["kind"]))}>
      <option value="literal">常量</option>
      <option value="variable">变量</option>
      <option value="array">数组</option>
      <option value="object">对象</option>
    </select>
    {value.kind === "literal" && <input className="input" value={literalText(value.value)} onChange={(event) => onChange({ kind: "literal", value: parseLiteral(event.target.value) })} />}
    {value.kind === "variable" && <VariablePathEditor path={value.path} variables={variables} onChange={(path) => onChange({ kind: "variable", path })} />}
    {value.kind === "array" && <>
      {value.items.map((item, index) => <div className="nested-box" key={index}>
        <ValueTemplateEditor value={item} variables={variables} onChange={(next) => onChange({ kind: "array", items: value.items.map((current, itemIndex) => itemIndex === index ? next : current) })} />
        <Btn variant="subtle" onClick={() => onChange({ kind: "array", items: value.items.filter((_item, itemIndex) => itemIndex !== index) })}>移除</Btn>
      </div>)}
      <Btn onClick={() => onChange({ kind: "array", items: [...value.items, { kind: "literal", value: "" }] })}>+ 元素</Btn>
    </>}
    {value.kind === "object" && <>
      {Object.entries(value.entries).map(([key, item]) => <div className="nested-box" key={key}>
        <div className="variable-row">
          <input className="input" value={key} readOnly />
          <Btn variant="subtle" onClick={() => { const { [key]: _dropped, ...rest } = value.entries; onChange({ kind: "object", entries: rest }); }}>×</Btn>
        </div>
        <ValueTemplateEditor value={item} variables={variables} onChange={(next) => onChange({ kind: "object", entries: { ...value.entries, [key]: next } })} />
      </div>)}
      <Btn onClick={() => onChange({ kind: "object", entries: { ...value.entries, [`field${Object.keys(value.entries).length + 1}`]: { kind: "literal", value: "" } } })}>+ 字段</Btn>
    </>}
  </div>;
}

function ExpressionEditor({ label, value, variables, onChange }: {
  label?: string; value: WorkflowExpression; variables: WorkflowVariableDefinition[]; onChange: (value: WorkflowExpression) => void;
}) {
  return <div className="expression-box">
    {label && <span className="field-label">{label}</span>}
    <select className="input" value={value.kind} onChange={(event) => onChange(newExpression(event.target.value as WorkflowExpression["kind"]))}>
      <option value="literal">常量</option>
      <option value="variable">变量</option>
      <option value="unary">单目</option>
      <option value="binary">比较 / 算术</option>
      <option value="logical">逻辑</option>
    </select>
    {value.kind === "literal" && <input className="input" value={literalText(value.value)} onChange={(event) => onChange({ kind: "literal", value: parseLiteral(event.target.value) })} />}
    {value.kind === "variable" && <VariablePathEditor path={value.path} variables={variables} onChange={(path) => onChange({ kind: "variable", path })} />}
    {value.kind === "unary" && <>
      <select className="input" value={value.operator} onChange={(event) => onChange({ ...value, operator: event.target.value as "not" | "negate" })}>
        <option value="not">not</option>
        <option value="negate">negate</option>
      </select>
      <ExpressionEditor value={value.operand} variables={variables} onChange={(operand) => onChange({ ...value, operand })} />
    </>}
    {value.kind === "binary" && <>
      <select className="input" value={value.operator} onChange={(event) => onChange({ ...value, operator: event.target.value as typeof value.operator })}>
        {["add", "subtract", "multiply", "divide", "modulo", "eq", "neq", "gt", "gte", "lt", "lte"].map((item) => <option key={item}>{item}</option>)}
      </select>
      <ExpressionEditor value={value.left} variables={variables} onChange={(left) => onChange({ ...value, left })} />
      <ExpressionEditor value={value.right} variables={variables} onChange={(right) => onChange({ ...value, right })} />
    </>}
    {value.kind === "logical" && <>
      <select className="input" value={value.operator} onChange={(event) => onChange({ ...value, operator: event.target.value as "and" | "or" })}>
        <option value="and">and</option>
        <option value="or">or</option>
      </select>
      {value.operands.map((operand, index) => <ExpressionEditor key={index} value={operand} variables={variables} onChange={(next) => onChange({ ...value, operands: value.operands.map((item, itemIndex) => itemIndex === index ? next : item) })} />)}
      <Btn onClick={() => onChange({ ...value, operands: [...value.operands, { kind: "literal", value: true }] })}>+ 操作数</Btn>
    </>}
  </div>;
}

/** Variable paths are always a declared top-level name plus optional own-property sub-path;
 *  the root can only be picked from the declaration list, never typed. */
function VariablePathEditor({ path, variables, onChange }: { path: string; variables: WorkflowVariableDefinition[]; onChange: (path: string) => void }) {
  const [root, ...rest] = path.split(".");
  return <div className="variable-path">
    <VariableSelect value={root ?? ""} variables={variables} onChange={(next) => onChange([next, ...rest].filter(Boolean).join("."))} />
    <label className="field"><span className="field-label">子属性（可选）</span><input className="input" value={rest.join(".")} placeholder="measurement.value" onChange={(event) => onChange([root, event.target.value].filter(Boolean).join("."))} /></label>
  </div>;
}

function NestedAdd({ label, onAdd }: { label: string; onAdd: (step: TestStep) => void }) {
  return <label className="field">
    <span className="field-label">{label}</span>
    <select className="input" value="" onChange={(event) => { if (event.target.value) onAdd(newStep(event.target.value as TestStep["type"])); }}>
      <option value="">选择类型…</option>
      {STEP_TYPES.map((type) => <option key={type} value={type}>{stepTypeLabel(type)}</option>)}
    </select>
  </label>;
}
