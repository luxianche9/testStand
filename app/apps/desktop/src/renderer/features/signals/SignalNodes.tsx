import { memo, useState } from "react";
import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import type { HardwareSignalNode, WidgetSignalNode } from "@teststand/contracts/signals";
import { ChevronRightIcon, Settings2Icon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import { IconButton, StatusLamp, cn } from "../../ui/index.js";
import { WIDGET_LABELS, handleId, widgetHandle, type SignalInfo } from "./signal-model.js";
import {
  LampsWidget, ScopeWidget, SetpointWidget, SwitchWidget, TerminalWidget, ValueWidget, type WidgetInput
} from "./widgets.js";

export type HardwareNodeData = {
  node: HardwareSignalNode;
  label: string;
  kind: "managed" | "passive" | "missing";
  /** The device's streams are not known yet (it was never connected). */
  unknown: boolean;
  online: boolean | undefined;
  signals: SignalInfo[];
  onInfo: (hardwareId: string) => void;
  /** Opens the device's actions (tools without a stream, such as configuring a port). */
  onControl: (hardwareId: string, anchor: DOMRect) => void;
};
export type WidgetNodeData = {
  node: WidgetSignalNode;
  inputs: WidgetInput[];
  onRemove: (nodeId: string) => void;
  onRename: (nodeId: string, label: string) => void;
  onResize: (nodeId: string, width: number, height: number) => void;
};
export type HardwareFlowNode = Node<HardwareNodeData, "hardware">;
export type WidgetFlowNode = Node<WidgetNodeData, "widget">;
export type SignalFlowNode = HardwareFlowNode | WidgetFlowNode;

const TYPE_LABELS: Record<string, string> = { scalar: "模拟", bits: "位", bytes: "字节", frames: "帧" };
const DIRECTION_LABELS = { input: "入", output: "出", bidirectional: "双向" } as const;
const KIND_LABELS = { passive: "被测对象", managed: "设备", missing: "未登记" } as const;

function SignalHandles({ id, type }: { id: string; type: string }) {
  return (
    <>
      <Handle type="target" position={Position.Left} id={id} className="signal-handle" data-type={type} />
      <Handle type="source" position={Position.Right} id={id} className="signal-handle" data-type={type} />
    </>
  );
}

function SignalRow({ signal }: { signal: SignalInfo }) {
  const [open, setOpen] = useState(false);
  const bits = signal.type === "bits" && signal.origin === "device" && (signal.width ?? 0) > 1;
  const writable = signal.actions.length > 0;
  return (
    <li>
      <div className="relative flex h-6 items-center gap-1.5 px-3 text-2xs">
        <SignalHandles id={handleId(signal.id)} type={String(signal.type)} />
        {bits ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "收起" : "展开"} ${signal.label} 的各位`}
            className="nodrag -ml-1 grid size-4 place-items-center text-fg-3 hover:text-fg"
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
          </button>
        ) : <span className="w-3" />}
        <span className="min-w-0 flex-1 truncate text-fg" title={signal.id}>{signal.label}</span>
        {signal.direction && <span className="text-fg-3">{DIRECTION_LABELS[signal.direction]}</span>}
        {writable && <span className="text-signal" title="可写">写</span>}
        <span className="font-mono text-fg-3">
          {TYPE_LABELS[signal.type] ?? signal.type}{signal.width && signal.width > 1 ? signal.width : ""}
        </span>
      </div>
      {bits && open && (
        <ul className="border-y border-line bg-surface-0/60">
          {Array.from({ length: signal.width ?? 0 }, (_, bit) => (
            <li key={bit} className="relative flex h-5 items-center pr-3 pl-7 text-2xs text-fg-2">
              <SignalHandles id={handleId(signal.id, bit)} type="bits" />
              <span className="truncate">{signal.bitLabels?.[bit] ?? `bit ${bit}`}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** A device or a passive part: its signals as rows, each with an input (left) and output (right). */
export const HardwareNodeView = memo(function HardwareNodeView({ data, selected }: NodeProps<HardwareFlowNode>) {
  return (
    <div className={cn(
      "w-64 overflow-hidden rounded-md border bg-surface-1 shadow-sm",
      selected ? "border-signal" : "border-line-strong",
      data.kind === "missing" && "border-dashed opacity-70"
    )}>
      <header className="flex h-8 items-center gap-2 border-b border-line bg-surface-2 px-2.5">
        {data.kind === "managed" && (
          <StatusLamp tone={data.online ? "pass" : data.online === false ? "fail" : "neutral"}
            label={data.online ? "在线" : "离线"} />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fg">{data.label}</span>
        <span className="text-2xs text-fg-3">{KIND_LABELS[data.kind]}</span>
        {data.kind === "managed" && (
          <IconButton label={`控制 ${data.label}`} size="icon-sm" variant="ghost" className="nodrag -mr-1"
            onClick={(event) => data.onControl(data.node.hardwareId, event.currentTarget.getBoundingClientRect())}>
            <SlidersHorizontalIcon />
          </IconButton>
        )}
        {data.kind !== "missing" && (
          <IconButton label="硬件信息" size="icon-sm" variant="ghost" className="nodrag -mr-1"
            onClick={() => data.onInfo(data.node.hardwareId)}>
            <Settings2Icon />
          </IconButton>
        )}
      </header>
      {data.signals.length ? (
        <ul className="py-1">{data.signals.map((signal) => <SignalRow key={signal.id} signal={signal} />)}</ul>
      ) : (
        <p className="px-3 py-3 text-2xs text-fg-3">
          {data.kind === "missing" ? `${data.node.hardwareId} 不在设备目录中`
            : data.unknown ? "设备连接后显示它声明的信号"
            : data.kind === "passive" ? "没有声明信号，在硬件信息里添加" : "这台设备没有声明数据流"}
        </p>
      )}
    </div>
  );
});

function WidgetBody({ data }: { data: WidgetNodeData }) {
  const { node, inputs } = data;
  const first = inputs[0];
  switch (node.widget) {
    case "scope": return <ScopeWidget inputs={inputs} />;
    case "value": return <ValueWidget input={first} />;
    case "lamps": return <LampsWidget input={first} />;
    case "terminal": return <TerminalWidget node={node} input={first} />;
    case "switch": return <SwitchWidget node={node} input={first} />;
    case "setpoint": return <SetpointWidget node={node} input={first} />;
  }
}

/** A display or control on the canvas, sized by its node; displays take signals on the left. */
export const WidgetNodeView = memo(function WidgetNodeView({ data, selected }: NodeProps<WidgetFlowNode>) {
  const { node } = data;
  const handle = widgetHandle(node.widget);
  const [editing, setEditing] = useState(false);
  const title = node.label || (data.inputs.length === 1 ? data.inputs[0]!.label : WIDGET_LABELS[node.widget]);
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={80}
        onResizeEnd={(_event, size) => data.onResize(node.nodeId, size.width, size.height)}
      />
      <Handle
        type={handle === "in" ? "target" : "source"}
        position={handle === "in" ? Position.Left : Position.Right}
        id={handle}
        className="signal-handle"
        style={{ top: 16 }}
      />
      <div className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md border bg-surface-1 shadow-sm",
        selected ? "border-signal" : "border-line-strong"
      )}>
        <header className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line bg-surface-2 pr-1 pl-2.5">
          <span className="text-2xs text-fg-3">{WIDGET_LABELS[node.widget]}</span>
          {editing ? (
            <input
              autoFocus
              aria-label="控件名称"
              className="nodrag h-5 min-w-0 flex-1 rounded-xs border border-line bg-surface-0 px-1 text-xs text-fg"
              defaultValue={node.label}
              onBlur={(event) => { data.onRename(node.nodeId, event.target.value.trim()); setEditing(false); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs text-fg" title="双击重命名"
              onDoubleClick={() => setEditing(true)}>
              {title}
            </span>
          )}
          <IconButton label="移除控件" size="icon-sm" variant="ghost" className="nodrag"
            onClick={() => data.onRemove(node.nodeId)}>
            <XIcon />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1"><WidgetBody data={data} /></div>
      </div>
    </>
  );
});
