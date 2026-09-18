import { useEffect, useMemo, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import type { TestExpressionReference } from "@hardwareharness/contracts/testing";
import { Button } from "../../shared/ui/button";
import { Input, Select, Textarea } from "../../shared/ui/input";
import { cn } from "../../shared/ui/cn";

type Clause = { left: string; operator: string; rightKind: "literal" | "reference"; right: string };

export function ExpressionEditor({ value, references, mode, onChange }: {
  value: string;
  references: TestExpressionReference[];
  mode: "value" | "condition";
  onChange: (value: string) => void;
}) {
  const parsed = useMemo(() => mode === "condition" ? parseCondition(value, references) : parseValue(value, references), [mode, references, value]);
  const [advanced, setAdvanced] = useState(!parsed);
  const [join, setJoin] = useState<"all" | "any">(parsed?.join ?? "all");
  const [clauses, setClauses] = useState<Clause[]>(parsed?.clauses ?? [emptyClause(references)]);
  useEffect(() => {
    if (!parsed) { setAdvanced(true); return; }
    setJoin(parsed.join); setClauses(parsed.clauses);
  }, [parsed]);
  const available = references.filter((item) => item.availability !== "unavailable");
  const emit = (next: Clause[], nextJoin = join) => {
    setClauses(next);
    onChange(mode === "condition" ? serializeCondition(next, nextJoin) : serializeValue(next[0]!));
  };
  return <div className="grid gap-2 rounded-md border bg-secondary/20 p-2">
    <div className="flex items-center gap-1 rounded-md bg-secondary p-0.5 text-[11px]">
      <button type="button" className={cn("flex-1 rounded px-2 py-1", !advanced && "bg-background shadow-sm")} onClick={() => { if (!parsed) return; setAdvanced(false); }}>可视化</button>
      <button type="button" className={cn("flex-1 rounded px-2 py-1", advanced && "bg-background shadow-sm")} onClick={() => setAdvanced(true)}>高级 CEL</button>
    </div>
    {advanced ? <><Textarea className="min-h-24 font-mono text-[11px]" value={value} onChange={(event) => onChange(event.target.value)} />{!parsed && <div className="text-[10px] text-warning">当前表达式超出可视编辑范围。需要重建时可使用下方按钮。</div>} {!parsed && <Button size="xs" variant="outline" onClick={() => { const next = [emptyClause(references)]; setClauses(next); setJoin("all"); setAdvanced(false); emit(next, "all"); }}>重新用可视条件构建</Button>}</> : <div className="grid gap-2">
      {mode === "condition" && clauses.length > 1 && <Select aria-label="条件组合" value={join} onChange={(event) => { const next = event.target.value as "all" | "any"; setJoin(next); emit(clauses, next); }}><option value="all">全部满足</option><option value="any">任一满足</option></Select>}
      {mode === "value" ? <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-1"><Select aria-label="值来源类型" value={clauses[0]?.left ? "reference" : "literal"} onChange={(event) => { const next = event.target.value === "reference" ? { ...clauses[0]!, left: available[0]?.expression ?? "", right: "" } : { ...clauses[0]!, left: "", right: "" }; emit([next]); }}><option value="reference">数据引用</option><option value="literal">字面量</option></Select>{clauses[0]?.left ? <ReferenceSelect value={clauses[0].left} references={references} onChange={(left) => emit([{ ...clauses[0]!, left }])} /> : <Input aria-label="字面量" value={clauses[0]?.right ?? ""} placeholder="数字、true 或文本" onChange={(event) => emit([{ ...clauses[0]!, right: event.target.value }])} />}</div> : clauses.map((clause, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_88px_minmax(0,1fr)_auto] items-center gap-1">
        <ReferenceSelect value={clause.left} references={references} onChange={(left) => emit(clauses.map((item, itemIndex) => itemIndex === index ? { ...item, left } : item))} />
        <Select aria-label="运算符" value={clause.operator} onChange={(event) => emit(clauses.map((item, itemIndex) => itemIndex === index ? { ...item, operator: event.target.value } : item))}>{operatorOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select>
        <div className="grid grid-cols-[74px_1fr] gap-1"><Select aria-label="右值类型" value={clause.rightKind} onChange={(event) => emit(clauses.map((item, itemIndex) => itemIndex === index ? { ...item, rightKind: event.target.value as Clause["rightKind"], right: event.target.value === "reference" ? available[0]?.expression ?? "" : "" } : item))}><option value="literal">固定值</option><option value="reference">引用</option></Select>{clause.rightKind === "reference" ? <ReferenceSelect value={clause.right} references={references} onChange={(right) => emit(clauses.map((item, itemIndex) => itemIndex === index ? { ...item, right } : item))} /> : <Input aria-label="比较值" value={clause.right} placeholder="数字、true 或文本" onChange={(event) => emit(clauses.map((item, itemIndex) => itemIndex === index ? { ...item, right: event.target.value } : item))} />}</div>
        {clauses.length > 1 ? <Button size="icon-xs" variant="ghost" aria-label="删除条件" onClick={() => emit(clauses.filter((_item, itemIndex) => itemIndex !== index))}><Trash2Icon /></Button> : <span />}
      </div>)}
      {mode === "condition" && <Button size="xs" variant="outline" onClick={() => emit([...clauses, emptyClause(references)])}><PlusIcon />增加条件</Button>}
      {!available.length && <div className="text-[10px] text-warning">当前步骤之前没有可安全引用的数据。</div>}
    </div>}
  </div>;
}

function ReferenceSelect({ value, references, onChange }: { value: string; references: TestExpressionReference[]; onChange: (value: string) => void }) {
  return <Select aria-label="数据来源" value={value} onChange={(event) => onChange(event.target.value)}><option value="">选择数据来源</option>{references.map((item) => <option key={item.expression} value={item.expression} disabled={item.availability === "unavailable"}>{item.label}{item.unit ? ` (${item.unit})` : ""}{item.availability === "conditional" ? " [条件可用]" : item.availability === "unavailable" ? " [不可用]" : ""}</option>)}</Select>;
}

const operatorOptions = [["==", "等于"], ["!=", "不等于"], [">", "大于"], [">=", "大于等于"], ["<", "小于"], ["<=", "小于等于"], ["contains", "包含"]] as const;

function emptyClause(references: TestExpressionReference[]): Clause { return { left: references.find((item) => item.availability === "guaranteed")?.expression ?? "", operator: "==", rightKind: "literal", right: "" }; }
function literal(value: string): string { const trimmed = value.trim(); if (/^-?\d+(?:\.\d+)?$/.test(trimmed) || /^(true|false|null)$/i.test(trimmed)) return trimmed.toLowerCase(); return JSON.stringify(value); }
function serializeClause(clause: Clause): string { const right = clause.rightKind === "reference" ? clause.right : literal(clause.right); return clause.operator === "contains" ? `${right} in ${clause.left}` : `${clause.left} ${clause.operator} ${right}`; }
function serializeCondition(clauses: Clause[], join: "all" | "any"): string { return clauses.filter((item) => item.left).map(serializeClause).join(join === "all" ? " && " : " || ") || "false"; }
function serializeValue(clause: Clause): string { return clause.left || literal(clause.right); }
function parseValue(value: string, references: TestExpressionReference[]): { join: "all"; clauses: Clause[] } | undefined { const source = value.trim(); if (references.some((item) => item.expression === source)) return { join: "all", clauses: [{ left: source, operator: "==", rightKind: "literal", right: "" }] }; if (/^-?\d+(?:\.\d+)?$/.test(source) || /^(true|false|null)$/i.test(source) || /^"(?:[^"\\]|\\.)*"$/.test(source)) return { join: "all", clauses: [{ left: "", operator: "==", rightKind: "literal", right: parseLiteral(source) }] }; return undefined; }
function parseCondition(value: string, references: TestExpressionReference[]): { join: "all" | "any"; clauses: Clause[] } | undefined {
  const source = value.trim(); if (!source) return undefined;
  const join: "all" | "any" = source.includes(" || ") ? "any" : "all";
  if (source.includes(" && ") && source.includes(" || ")) return undefined;
  const parts = source.split(join === "all" ? " && " : " || ");
  const clauses: Clause[] = [];
  for (const part of parts) {
    const comparison = part.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    const contains = part.match(/^(.+?)\s+in\s+(.+)$/);
    if (!comparison && !contains) return undefined;
    const left = contains ? contains[2]!.trim() : comparison![1]!.trim();
    const operator = contains ? "contains" : comparison![2]!;
    const rawRight = contains ? contains[1]!.trim() : comparison![3]!.trim();
    const reference = /^(parameters|variables|steps)\./.test(rawRight);
    if (!references.some((item) => item.expression === left)) return undefined;
    if (reference && !references.some((item) => item.expression === rawRight)) return undefined;
    clauses.push({ left, operator, rightKind: reference ? "reference" : "literal", right: reference ? rawRight : parseLiteral(rawRight) });
  }
  return { join, clauses };
}
function parseLiteral(value: string): string { try { const parsed = JSON.parse(value); return typeof parsed === "string" ? parsed : String(parsed); } catch { return value; } }
