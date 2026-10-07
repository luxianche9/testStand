import { useState, type ReactNode } from "react";
import {
  ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, CircleIcon,
  CircleMinusIcon, CircleStopIcon, CircleXIcon, LoaderCircleIcon
} from "lucide-react";
import { cn } from "../../ui";
import { regionLabels, regionOrder } from "./plan-helpers.js";
import { durationText, flowChildren } from "./run-format.js";
import type { ExecutionTrace, ExecutionTraceNode } from "./run-log-model.js";

const STATES: Record<ExecutionTraceNode["state"], { icon: ReactNode; label: string; className: string }> = {
  waiting: { icon: <CircleIcon />, label: "未执行", className: "text-fg-3" },
  running: { icon: <LoaderCircleIcon className="animate-spin" />, label: "执行中", className: "text-run" },
  Pass: { icon: <CircleCheckIcon />, label: "通过", className: "text-pass" },
  Fail: { icon: <CircleXIcon />, label: "失败", className: "text-fail" },
  Error: { icon: <CircleAlertIcon />, label: "错误", className: "text-fail" },
  skipped: { icon: <CircleMinusIcon />, label: "跳过", className: "text-fg-3" },
  Aborted: { icon: <CircleStopIcon />, label: "已终止", className: "text-invalid" }
};

/**
 * 测试流程 of the open plan as an outliner: every step of every region as a tree, with the state
 * it has in the run shown (or 未执行 without one). A step that ran picks its time on the signal
 * view; a double click edits the step.
 */
export function PlanFlow({ trace, selectedStepId, typeLabel, onSelect, onEdit }: {
  trace: ExecutionTrace;
  selectedStepId: string | undefined;
  typeLabel: (type: string) => string;
  onSelect: (node: ExecutionTraceNode) => void;
  onEdit: (stepId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (executionId: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(executionId)) next.delete(executionId); else next.add(executionId);
    return next;
  });
  const rows = (nodes: ExecutionTraceNode[], depth: number): ReactNode => nodes.map((node) => {
    const children = flowChildren(node);
    const open = !collapsed.has(node.executionId);
    return (
      <li key={node.executionId} role="treeitem" aria-expanded={children.length ? open : undefined}
        aria-selected={node.stepId === selectedStepId}>
        <FlowRow
          node={node}
          depth={depth}
          open={children.length ? open : undefined}
          selected={node.stepId === selectedStepId}
          typeLabel={typeLabel}
          onToggle={() => toggle(node.executionId)}
          onSelect={() => onSelect(node)}
          onEdit={() => onEdit(node.stepId)}
        />
        {open && children.length > 0 && <ul role="group">{rows(children, depth + 1)}</ul>}
      </li>
    );
  });
  const regions = regionOrder.filter((region) => trace.regions[region].length);
  if (!regions.length) {
    return <p className="px-3 py-4 text-center text-xs text-fg-3">流程还没有步骤，点击「编辑」添加。</p>;
  }
  return (
    <ul role="tree" aria-label="测试流程" className="py-1">
      {regions.map((region) => (
        <li key={region} role="none">
          <div className="tf-label flex h-6 items-center gap-1.5 px-3 text-fg-3">
            {regionLabels[region]}<span className="tf-num">{trace.regions[region].length}</span>
          </div>
          <ul role="group">{rows(trace.regions[region], 0)}</ul>
        </li>
      ))}
    </ul>
  );
}

function FlowRow({ node, depth, open, selected, typeLabel, onToggle, onSelect, onEdit }: {
  node: ExecutionTraceNode;
  depth: number;
  open: boolean | undefined;
  selected: boolean;
  typeLabel: (type: string) => string;
  onToggle: () => void;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const state = STATES[node.state] ?? STATES.waiting;
  const scopes = node.iterations.length ? node.iterations : node.attempts;
  const current = scopes.at(-1);
  const count = current?.count ?? node.iterationCount ?? node.attemptCount;
  const scope = current
    ? node.iterations.length ? `${current.index + 1}${count ? `/${count}` : ""}` : `重试 ${current.index + 1}`
    : "";
  const name = node.step.name ?? typeLabel(node.step.type);
  const disabled = node.step.enabled === false;
  return (
    <div
      data-flow-step={node.stepId}
      title={`${name} · ${typeLabel(node.step.type)} · ${disabled ? "已禁用" : state.label}`}
      className={cn(
        "group flex h-6 cursor-default items-center gap-1 pr-2 text-xs select-none",
        selected ? "bg-signal/12 text-fg" : "text-fg-2 hover:bg-surface-2",
        disabled && "opacity-50"
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={onSelect}
      onDoubleClick={onEdit}
    >
      {open === undefined ? <span className="w-3.5 shrink-0" /> : (
        <button
          type="button"
          aria-label={open ? `折叠 ${name}` : `展开 ${name}`}
          className="grid size-3.5 shrink-0 place-items-center text-fg-3 hover:text-fg"
          onClick={(event) => { event.stopPropagation(); onToggle(); }}
        >
          {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        </button>
      )}
      <span aria-label={state.label}
        className={cn("grid shrink-0 place-items-center [&_svg]:size-3.5", state.className)}>
        {disabled ? <CircleDashedIcon /> : state.icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {scope && <span className="tf-num shrink-0 text-2xs text-fg-3">{scope}</span>}
      {node.durationMs != null && node.state !== "running" && (
        <span className="tf-num shrink-0 text-2xs text-fg-3">{durationText(node.durationMs)}</span>
      )}
    </div>
  );
}
