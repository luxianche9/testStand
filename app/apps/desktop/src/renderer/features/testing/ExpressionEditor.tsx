import { useEffect, useMemo, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import type { TestExpressionReference } from "@teststand/contracts/testing";
import { Button, IconButton, Input, SegmentedControl, Select, Textarea } from "../../ui";
import {
  emptyClause, operatorOptions, parseCondition, parseValue, serializeCondition, serializeValue, type Clause
} from "./expression-model.js";

type Mode = "value" | "condition";

export function ExpressionEditor({ value, references, mode, onChange }: {
  value: string;
  references: TestExpressionReference[];
  mode: Mode;
  onChange: (value: string) => void;
}) {
  const parsed = useMemo(
    () => mode === "condition" ? parseCondition(value, references) : parseValue(value, references),
    [mode, references, value]
  );
  const [advanced, setAdvanced] = useState(!parsed);
  const [join, setJoin] = useState<"all" | "any">(parsed?.join ?? "all");
  const [clauses, setClauses] = useState<Clause[]>(parsed?.clauses ?? [emptyClause(references)]);
  useEffect(() => {
    if (!parsed) { setAdvanced(true); return; }
    setJoin(parsed.join); setClauses(parsed.clauses);
  }, [parsed]);
  const available = references.filter((item) => item.availability !== "unavailable");
  // An empty expression is "not set", not an unsupported one: no warning, and 可视化 starts a fresh clause.
  const blank = !value.trim();
  const emit = (next: Clause[], nextJoin = join) => {
    setClauses(next);
    onChange(mode === "condition" ? serializeCondition(next, nextJoin) : serializeValue(next[0]!));
  };
  const rebuild = () => {
    const next = [emptyClause(references)];
    setClauses(next); setJoin("all"); setAdvanced(false); emit(next, "all");
  };

  return (
    <div className="grid gap-2 rounded-md border border-line bg-surface-0 p-2">
      <SegmentedControl
        label="表达式编辑方式"
        size="xs"
        className="self-start"
        value={advanced ? "advanced" : "visual"}
        options={[
          { value: "visual", label: "可视化", disabled: !parsed && !blank },
          { value: "advanced", label: "高级 CEL" }
        ]}
        onChange={(next) => next === "visual" && !parsed ? rebuild() : setAdvanced(next === "advanced")}
      />
      {advanced ? (
        <>
          <Textarea
            aria-label="CEL 表达式"
            className="min-h-16 font-mono text-xs"
            value={value}
            placeholder="留空则不使用表达式"
            onChange={(event) => onChange(event.target.value)}
          />
          {!parsed && !blank && (
            <p className="text-xs text-invalid">当前表达式超出可视编辑范围。需要重建时可使用下方按钮。</p>
          )}
          {!parsed && !blank && (
            <Button size="xs" variant="outline" className="justify-self-start" onClick={rebuild}>
              重新用可视条件构建
            </Button>
          )}
        </>
      ) : (
        <div className="grid gap-2">
          {mode === "condition" && clauses.length > 1 && (
            <Select
              aria-label="条件组合"
              value={join}
              onChange={(event) => {
                const next = event.target.value as "all" | "any";
                setJoin(next);
                emit(clauses, next);
              }}
            >
              <option value="all">全部满足</option>
              <option value="any">任一满足</option>
            </Select>
          )}
          {mode === "value"
            ? (
              <ValueRow
                clause={clauses[0]!}
                references={references}
                available={available}
                onEmit={(next) => emit([next])}
              />
            )
            : clauses.map((clause, index) => (
              <ClauseRow
                key={index}
                clause={clause}
                references={references}
                available={available}
                removable={clauses.length > 1}
                onChange={(next) => emit(clauses.map((item, itemIndex) => itemIndex === index ? next : item))}
                onRemove={() => emit(clauses.filter((_item, itemIndex) => itemIndex !== index))}
              />
            ))}
          {mode === "condition" && (
            <Button size="xs" variant="outline" className="justify-self-start"
              onClick={() => emit([...clauses, emptyClause(references)])}>
              <PlusIcon />增加条件
            </Button>
          )}
          {!available.length && <p className="text-xs text-invalid">当前步骤之前没有可安全引用的数据。</p>}
        </div>
      )}
    </div>
  );
}

function ValueRow({ clause, references, available, onEmit }: {
  clause: Clause;
  references: TestExpressionReference[];
  available: TestExpressionReference[];
  onEmit: (clause: Clause) => void;
}) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-1">
      <Select
        aria-label="值来源类型"
        value={clause.left ? "reference" : "literal"}
        onChange={(event) => onEmit(event.target.value === "reference"
          ? { ...clause, left: available[0]?.expression ?? "", right: "" }
          : { ...clause, left: "", right: "" })}
      >
        <option value="reference">数据引用</option>
        <option value="literal">字面量</option>
      </Select>
      {clause.left
        ? (
          <ReferenceSelect
            value={clause.left}
            references={references}
            onChange={(left) => onEmit({ ...clause, left })}
          />
        )
        : (
          <Input
            aria-label="字面量"
            className="font-mono"
            value={clause.right}
            placeholder="数字、true 或文本"
            onChange={(event) => onEmit({ ...clause, right: event.target.value })}
          />
        )}
    </div>
  );
}

function ClauseRow({ clause, references, available, removable, onChange, onRemove }: {
  clause: Clause;
  references: TestExpressionReference[];
  available: TestExpressionReference[];
  removable: boolean;
  onChange: (clause: Clause) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_88px_minmax(0,1fr)_auto] items-center gap-1">
      <ReferenceSelect value={clause.left} references={references} onChange={(left) => onChange({ ...clause, left })} />
      <Select aria-label="运算符" value={clause.operator}
        onChange={(event) => onChange({ ...clause, operator: event.target.value })}>
        {operatorOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </Select>
      <div className="grid grid-cols-[74px_1fr] gap-1">
        <Select
          aria-label="右值类型"
          value={clause.rightKind}
          onChange={(event) => {
            const rightKind = event.target.value as Clause["rightKind"];
            onChange({ ...clause, rightKind, right: rightKind === "reference" ? available[0]?.expression ?? "" : "" });
          }}
        >
          <option value="literal">固定值</option>
          <option value="reference">引用</option>
        </Select>
        {clause.rightKind === "reference"
          ? (
            <ReferenceSelect
              value={clause.right}
              references={references}
              onChange={(right) => onChange({ ...clause, right })}
            />
          )
          : (
            <Input aria-label="比较值" className="font-mono" value={clause.right} placeholder="数字、true 或文本"
              onChange={(event) => onChange({ ...clause, right: event.target.value })} />
          )}
      </div>
      {removable
        ? <IconButton label="删除条件" size="icon-xs" tooltip={false} onClick={onRemove}><Trash2Icon /></IconButton>
        : <span />}
    </div>
  );
}

function referenceSuffix(item: TestExpressionReference): string {
  const unit = item.unit ? ` (${item.unit})` : "";
  if (item.availability === "conditional") return `${unit} [条件可用]`;
  if (item.availability === "unavailable") return `${unit} [不可用]`;
  return unit;
}

function ReferenceSelect({ value, references, onChange }: {
  value: string;
  references: TestExpressionReference[];
  onChange: (value: string) => void;
}) {
  return (
    <Select aria-label="数据来源" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">选择数据来源</option>
      {references.map((item) => (
        <option key={item.expression} value={item.expression} disabled={item.availability === "unavailable"}>
          {item.label}{referenceSuffix(item)}
        </option>
      ))}
    </Select>
  );
}
