import { useState, type ReactNode } from "react";
import { CopyIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import type { ToolCatalogItem } from "@testforge/contracts/devices";
import type { ErrorCategory } from "@testforge/contracts/errors";
import type { TestStep, TestTask, WorkflowExpression, WorkflowValueTemplate, WorkflowVariableDefinition } from "@testforge/contracts/orchestration";
import { Button } from "../../shared/ui/button";
import { Checkbox } from "../../shared/ui/checkbox";
import { cn } from "../../shared/ui/cn";
import { Input, Select } from "../../shared/ui/input";
import { STEP_TYPES, literalText, newExpression, newStep, newValueTemplate, parseLiteral, stepTypeLabel } from "./workflow-model.js";

const RETRY_CATEGORIES: ErrorCategory[] = ["unavailable", "conflict", "error"];

const fieldClass = "grid content-start gap-1.5";
const fieldLabelClass = "text-xs text-muted-foreground";
const variableRowClass = "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-1.5";
const nestedBoxClass = "flex flex-col gap-1.5 rounded-xl bg-secondary/40 p-2 shadow-sm ring-1 ring-border";
const expressionBoxClass = nestedBoxClass;
const mutedCopyClass = "text-xs text-muted-foreground";

export function VariableEditor({ task, onChange }: { task: TestTask; onChange: (task: TestTask) => void }) {
  const [tab, setTab] = useState<"inputs" | "variables">("variables");
  const values = task[tab];
  const update = (index: number, value: WorkflowVariableDefinition) =>
    onChange({ ...task, [tab]: values.map((item, itemIndex) => itemIndex === index ? value : item) });
  return <div className="flex flex-col gap-1.5 rounded-xl bg-card p-2.5 shadow-sm ring-1 ring-border">
    <div className="flex items-center justify-between gap-2">
      <div className="flex rounded-lg bg-secondary/50 p-0.5 shadow-sm ring-1 ring-border" role="group" aria-label="变量类别">
        {(["inputs", "variables"] as const).map((name) => <button
          key={name}
          onClick={() => setTab(name)}
          className={cn("h-6.5 min-w-13 rounded-sm px-2.5 text-xs", tab === name ? "bg-background text-foreground shadow-xs" : "text-muted-foreground")}
        >{name === "inputs" ? "输入" : "变量"} {task[name].length}</button>)}
      </div>
      <Button variant="outline" size="xs" onClick={() => onChange({ ...task, [tab]: [...values, { name: `${tab === "inputs" ? "input" : "value"}_${values.length + 1}`, type: "unknown" }] })}><PlusIcon className="size-3.5" />新增</Button>
    </div>
    {values.map((item, index) => <div className={variableRowClass} key={`${tab}-${index}`}>
      <Input value={item.name} onChange={(event) => update(index, { ...item, name: event.target.value })} aria-label="变量名" />
      <Select value={item.type} onChange={(event) => update(index, { ...item, type: event.target.value as WorkflowVariableDefinition["type"] })}>
        {["string", "number", "boolean", "object", "array", "unknown"].map((type) => <option key={type}>{type}</option>)}
      </Select>
      <Button variant="ghost" size="icon-sm" aria-label="删除变量" onClick={() => onChange({ ...task, [tab]: values.filter((_item, itemIndex) => itemIndex !== index) })}><XIcon className="size-3.5" /></Button>
    </div>)}
    {!values.length && <small className={mutedCopyClass}>{tab === "inputs" ? "输入在启动 Run 时赋值，步骤内只读。" : "变量只能由步骤写入，且必须先在这里声明。"}</small>}
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
    <label className={fieldClass}><span className={fieldLabelClass}>失败消息</span><Input value={step.message} onChange={(event) => onChange({ ...step, message: event.target.value })} /></label>
  </>;
  else if (step.type === "if") fields = <>
    <ExpressionEditor label="条件" value={step.condition} variables={variables} onChange={(condition) => onChange({ ...step, condition })} />
    <NestedAdd label="向 Then 添加步骤" onAdd={(value) => onChange({ ...step, then: [...step.then, value] })} />
    <NestedAdd label="向 Else 添加步骤" onAdd={(value) => onChange({ ...step, else: [...step.else, value] })} />
  </>;
  else if (step.type === "loop") fields = <>
    <label className={fieldClass}><span className={fieldLabelClass}>模式</span>
      <Select value={step.mode} onChange={(event) => onChange({ ...step, mode: event.target.value as "count" | "while" })}>
        <option value="count">count（固定次数）</option>
        <option value="while">while（条件为真）</option>
      </Select>
    </label>
    {step.mode === "count"
      ? <ValueTemplateEditor label="次数" value={step.count ?? { kind: "literal", value: 1 }} variables={variables} onChange={(count) => onChange({ ...step, count })} />
      : <ExpressionEditor label="循环条件" value={step.condition ?? { kind: "literal", value: true }} variables={variables} onChange={(condition) => onChange({ ...step, condition })} />}
    <label className={fieldClass}><span className={fieldLabelClass}>最大次数</span><Input type="number" value={step.maxIterations} onChange={(event) => onChange({ ...step, maxIterations: Number(event.target.value) })} /></label>
    <VariableSelect label="迭代序号写入" value={step.indexVariable} variables={writable.filter((item) => item.type === "number" || item.type === "unknown")} onChange={(indexVariable) => onChange({ ...step, indexVariable })} />
    <NestedAdd label="向 Body 添加步骤" onAdd={(value) => onChange({ ...step, body: [...step.body, value] })} />
  </>;
  else if (step.type === "parallel") fields = <>
    {step.branches.map((branch, index) => <div className={nestedBoxClass} key={branch.branchId}>
      <Input value={branch.name} onChange={(event) => onChange({ ...step, branches: step.branches.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} />
      <NestedAdd label="添加步骤" onAdd={(value) => onChange({ ...step, branches: step.branches.map((item, itemIndex) => itemIndex === index ? { ...item, steps: [...item.steps, value] } : item) })} />
    </div>)}
    <Button variant="outline" size="sm" onClick={() => onChange({ ...step, branches: [...step.branches, { branchId: crypto.randomUUID(), name: `Branch ${String.fromCharCode(65 + step.branches.length)}`, steps: [] }] })}><PlusIcon className="size-3.5" />新增分支</Button>
    <small className={mutedCopyClass}>并行分支不能写入同一个变量，校验会报 parallel_shared_write。</small>
  </>;
  else if (step.type === "operator") fields = <>
    <label className={fieldClass}><span className={fieldLabelClass}>提示语</span><Input value={step.prompt} onChange={(event) => onChange({ ...step, prompt: event.target.value })} /></label>
    <VariableSelect allowEmpty label="选择结果写入" value={step.resultVariable ?? ""} variables={writable} onChange={(resultVariable) => {
      if (resultVariable) onChange({ ...step, resultVariable });
      else { const { resultVariable: _dropped, ...rest } = step; onChange(rest); }
    }} />
    <div className={nestedBoxClass}>
      <strong className="text-sm font-medium">可选项</strong>
      {step.options.map((option, index) => <div className={variableRowClass} key={index}>
        <Input value={option.label} placeholder="显示文字" onChange={(event) => onChange({ ...step, options: step.options.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) })} />
        <Input value={String(option.value)} placeholder="值" onChange={(event) => onChange({ ...step, options: step.options.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item) })} />
        <Button variant="ghost" size="icon-sm" aria-label="删除选项" onClick={() => onChange({ ...step, options: step.options.filter((_item, itemIndex) => itemIndex !== index) })}><XIcon className="size-3.5" /></Button>
      </div>)}
      <Button variant="outline" size="sm" onClick={() => onChange({ ...step, options: [...step.options, { label: "继续", value: "continue" }] })}><PlusIcon className="size-3.5" />新增选项</Button>
    </div>
  </>;
  else if (step.type === "tool") fields = <>
    <label className={fieldClass}><span className={fieldLabelClass}>硬件工具</span>
      <Select value={step.toolName} onChange={(event) => onChange({ ...step, toolName: event.target.value })}>
        <option value="">选择工具</option>
        {tools.filter((tool) => tool.kind === "hardware").map((tool) => <option key={tool.externalName} value={tool.externalName}>{tool.externalName}</option>)}
      </Select>
    </label>
    <label className={fieldClass}><span className={fieldLabelClass}>Hardware ID</span><Input value={step.hardwareId} onChange={(event) => onChange({ ...step, hardwareId: event.target.value })} /></label>
    <label className={fieldClass}><span className={fieldLabelClass}>超时 ms</span><Input type="number" value={step.timeoutMs} onChange={(event) => onChange({ ...step, timeoutMs: Number(event.target.value) })} /></label>
    <label className="flex items-center gap-2 text-sm"><Checkbox checked={step.idempotent} onCheckedChange={(checked) => { const idempotent = checked === true; onChange({ ...step, idempotent, retry: idempotent ? step.retry : { ...step.retry, maxAttempts: 1 } }); }} /><span>该操作可安全重复（幂等）</span></label>
    <div className={variableRowClass}>
      <label className={fieldClass}><span className={fieldLabelClass}>重试次数</span><Input type="number" disabled={!step.idempotent} value={step.idempotent ? step.retry.maxAttempts : 1} onChange={(event) => onChange({ ...step, retry: { ...step.retry, maxAttempts: Number(event.target.value) } })} /></label>
      <label className={fieldClass}><span className={fieldLabelClass}>重试间隔 ms</span><Input type="number" value={step.retry.delayMs} onChange={(event) => onChange({ ...step, retry: { ...step.retry, delayMs: Number(event.target.value) } })} /></label>
      <label className={fieldClass}><span className={fieldLabelClass}>退避</span><Select value={step.retry.backoff} onChange={(event) => onChange({ ...step, retry: { ...step.retry, backoff: event.target.value as "fixed" | "exponential" } })}><option value="fixed">固定</option><option value="exponential">指数</option></Select></label>
    </div>
    <div className={fieldClass}><span className={fieldLabelClass}>仅重试错误类别</span><div className="flex flex-wrap gap-3">{RETRY_CATEGORIES.map((category) => <label key={category} className="flex items-center gap-2 text-sm"><Checkbox disabled={!step.idempotent} checked={step.retry.retryOn.includes(category)} onCheckedChange={(checked) => onChange({ ...step, retry: { ...step.retry, retryOn: checked === true ? [...step.retry.retryOn, category] : step.retry.retryOn.filter((item) => item !== category) } })} />{category}</label>)}</div></div>
    {!step.idempotent && <small className={mutedCopyClass}>非幂等操作强制只执行一次，避免真实硬件动作被盲目重发。</small>}
    <div className={nestedBoxClass}>
      <strong className="text-sm font-medium">调用参数</strong>
      {Object.entries(step.arguments).map(([name, value]) => <div className={nestedBoxClass} key={name}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
          <Input value={name} readOnly aria-label="参数名" />
          <Button variant="ghost" size="icon-sm" aria-label="删除参数" onClick={() => { const { [name]: _dropped, ...rest } = step.arguments; onChange({ ...step, arguments: rest }); }}><XIcon className="size-3.5" /></Button>
        </div>
        <ValueTemplateEditor value={value} variables={variables} onChange={(next) => onChange({ ...step, arguments: { ...step.arguments, [name]: next } })} />
      </div>)}
      <ArgumentAdder existing={Object.keys(step.arguments)} onAdd={(name) => onChange({ ...step, arguments: { ...step.arguments, [name]: { kind: "literal", value: "" } } })} />
    </div>
    <div className={nestedBoxClass}>
      <strong className="text-sm font-medium">输出绑定</strong>
      {step.outputBindings.map((binding, index) => <div className={variableRowClass} key={index}>
        <VariableSelect label="变量" value={binding.variable} variables={writable} onChange={(variable) => onChange({ ...step, outputBindings: step.outputBindings.map((item, itemIndex) => itemIndex === index ? { ...item, variable } : item) })} />
        <label className={fieldClass}><span className={fieldLabelClass}>JSON Pointer</span><Input value={binding.pointer} placeholder="/value" onChange={(event) => onChange({ ...step, outputBindings: step.outputBindings.map((item, itemIndex) => itemIndex === index ? { ...item, pointer: event.target.value } : item) })} /></label>
        <Button variant="ghost" size="icon-sm" aria-label="删除绑定" onClick={() => onChange({ ...step, outputBindings: step.outputBindings.filter((_item, itemIndex) => itemIndex !== index) })}><XIcon className="size-3.5" /></Button>
      </div>)}
      <Button variant="outline" size="sm" onClick={() => onChange({ ...step, outputBindings: [...step.outputBindings, { variable: writable[0]?.name ?? "", pointer: "" }] })}><PlusIcon className="size-3.5" />新增绑定</Button>
    </div>
  </>;

  return <div className="flex flex-col gap-3">
    <label className={fieldClass}><span className={fieldLabelClass}>名称</span><Input value={step.label} onChange={(event) => onChange({ ...step, label: event.target.value })} /></label>
    <label className="flex items-center gap-2 text-sm"><Checkbox checked={step.enabled} onCheckedChange={(checked) => onChange({ ...step, enabled: checked === true })} /><span>启用该步骤</span></label>
    {fields}
    <footer className="mt-1 flex gap-2 pt-3">
      <Button variant="outline" size="sm" onClick={onDuplicate}><CopyIcon className="size-3.5" />复制</Button>
      <Button variant="destructive" size="sm" onClick={onDelete}><Trash2Icon className="size-3.5" />删除</Button>
    </footer>
  </div>;
}

function ArgumentAdder({ existing, onAdd }: { existing: string[]; onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  const invalid = !name.trim() || existing.includes(name.trim());
  return <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
    <Input value={name} placeholder="参数名" onChange={(event) => setName(event.target.value)} />
    <Button variant="outline" size="sm" disabled={invalid} onClick={() => { onAdd(name.trim()); setName(""); }}>新增参数</Button>
  </div>;
}

function VariableSelect({ label = "变量", value, variables, onChange, allowEmpty = false }: {
  label?: string; value: string; variables: WorkflowVariableDefinition[]; onChange: (value: string) => void; allowEmpty?: boolean;
}) {
  return <label className={fieldClass}>
    <span className={fieldLabelClass}>{label}</span>
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      {allowEmpty && <option value="">不绑定</option>}
      {!allowEmpty && !value && <option value="">选择变量</option>}
      {variables.map((item) => <option key={item.name} value={item.name}>{item.name}（{item.type}）</option>)}
    </Select>
  </label>;
}

function ValueTemplateEditor({ label, value, variables, onChange }: {
  label?: string; value: WorkflowValueTemplate; variables: WorkflowVariableDefinition[]; onChange: (value: WorkflowValueTemplate) => void;
}) {
  return <div className={expressionBoxClass}>
    {label && <span className={fieldLabelClass}>{label}</span>}
    <Select value={value.kind} onChange={(event) => onChange(newValueTemplate(event.target.value as WorkflowValueTemplate["kind"]))}>
      <option value="literal">常量</option>
      <option value="variable">变量</option>
      <option value="array">数组</option>
      <option value="object">对象</option>
    </Select>
    {value.kind === "literal" && <Input value={literalText(value.value)} onChange={(event) => onChange({ kind: "literal", value: parseLiteral(event.target.value) })} />}
    {value.kind === "variable" && <VariablePathEditor path={value.path} variables={variables} onChange={(path) => onChange({ kind: "variable", path })} />}
    {value.kind === "array" && <>
      {value.items.map((item, index) => <div className={nestedBoxClass} key={index}>
        <ValueTemplateEditor value={item} variables={variables} onChange={(next) => onChange({ kind: "array", items: value.items.map((current, itemIndex) => itemIndex === index ? next : current) })} />
        <Button variant="ghost" size="xs" onClick={() => onChange({ kind: "array", items: value.items.filter((_item, itemIndex) => itemIndex !== index) })}>移除</Button>
      </div>)}
      <Button variant="outline" size="sm" onClick={() => onChange({ kind: "array", items: [...value.items, { kind: "literal", value: "" }] })}>+ 元素</Button>
    </>}
    {value.kind === "object" && <>
      {Object.entries(value.entries).map(([key, item]) => <div className={nestedBoxClass} key={key}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
          <Input value={key} readOnly />
          <Button variant="ghost" size="icon-sm" aria-label="删除字段" onClick={() => { const { [key]: _dropped, ...rest } = value.entries; onChange({ kind: "object", entries: rest }); }}><XIcon className="size-3.5" /></Button>
        </div>
        <ValueTemplateEditor value={item} variables={variables} onChange={(next) => onChange({ kind: "object", entries: { ...value.entries, [key]: next } })} />
      </div>)}
      <Button variant="outline" size="sm" onClick={() => onChange({ kind: "object", entries: { ...value.entries, [`field${Object.keys(value.entries).length + 1}`]: { kind: "literal", value: "" } } })}>+ 字段</Button>
    </>}
  </div>;
}

function ExpressionEditor({ label, value, variables, onChange }: {
  label?: string; value: WorkflowExpression; variables: WorkflowVariableDefinition[]; onChange: (value: WorkflowExpression) => void;
}) {
  return <div className={expressionBoxClass}>
    {label && <span className={fieldLabelClass}>{label}</span>}
    <Select value={value.kind} onChange={(event) => onChange(newExpression(event.target.value as WorkflowExpression["kind"]))}>
      <option value="literal">常量</option>
      <option value="variable">变量</option>
      <option value="unary">单目</option>
      <option value="binary">比较 / 算术</option>
      <option value="logical">逻辑</option>
    </Select>
    {value.kind === "literal" && <Input value={literalText(value.value)} onChange={(event) => onChange({ kind: "literal", value: parseLiteral(event.target.value) })} />}
    {value.kind === "variable" && <VariablePathEditor path={value.path} variables={variables} onChange={(path) => onChange({ kind: "variable", path })} />}
    {value.kind === "unary" && <>
      <Select value={value.operator} onChange={(event) => onChange({ ...value, operator: event.target.value as "not" | "negate" })}>
        <option value="not">not</option>
        <option value="negate">negate</option>
      </Select>
      <ExpressionEditor value={value.operand} variables={variables} onChange={(operand) => onChange({ ...value, operand })} />
    </>}
    {value.kind === "binary" && <>
      <Select value={value.operator} onChange={(event) => onChange({ ...value, operator: event.target.value as typeof value.operator })}>
        {["add", "subtract", "multiply", "divide", "modulo", "eq", "neq", "gt", "gte", "lt", "lte"].map((item) => <option key={item}>{item}</option>)}
      </Select>
      <ExpressionEditor value={value.left} variables={variables} onChange={(left) => onChange({ ...value, left })} />
      <ExpressionEditor value={value.right} variables={variables} onChange={(right) => onChange({ ...value, right })} />
    </>}
    {value.kind === "logical" && <>
      <Select value={value.operator} onChange={(event) => onChange({ ...value, operator: event.target.value as "and" | "or" })}>
        <option value="and">and</option>
        <option value="or">or</option>
      </Select>
      {value.operands.map((operand, index) => <ExpressionEditor key={index} value={operand} variables={variables} onChange={(next) => onChange({ ...value, operands: value.operands.map((item, itemIndex) => itemIndex === index ? next : item) })} />)}
      <Button variant="outline" size="sm" onClick={() => onChange({ ...value, operands: [...value.operands, { kind: "literal", value: true }] })}>+ 操作数</Button>
    </>}
  </div>;
}

/** Variable paths are always a declared top-level name plus optional own-property sub-path;
 *  the root can only be picked from the declaration list, never typed. */
function VariablePathEditor({ path, variables, onChange }: { path: string; variables: WorkflowVariableDefinition[]; onChange: (path: string) => void }) {
  const [root, ...rest] = path.split(".");
  return <div className="grid grid-cols-[minmax(120px,0.8fr)_minmax(160px,1.2fr)] items-end gap-2">
    <VariableSelect value={root ?? ""} variables={variables} onChange={(next) => onChange([next, ...rest].filter(Boolean).join("."))} />
    <label className={fieldClass}><span className={fieldLabelClass}>子属性（可选）</span><Input value={rest.join(".")} placeholder="measurement.value" onChange={(event) => onChange([root, event.target.value].filter(Boolean).join("."))} /></label>
  </div>;
}

function NestedAdd({ label, onAdd }: { label: string; onAdd: (step: TestStep) => void }) {
  return <label className={fieldClass}>
    <span className={fieldLabelClass}>{label}</span>
    <Select value="" onChange={(event) => { if (event.target.value) onAdd(newStep(event.target.value as TestStep["type"])); }}>
      <option value="">选择类型…</option>
      {STEP_TYPES.map((type) => <option key={type} value={type}>{stepTypeLabel(type)}</option>)}
    </Select>
  </label>;
}
