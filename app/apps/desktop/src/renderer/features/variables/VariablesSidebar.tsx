import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { StreamRef } from "@teststand/contracts/monitor";
import type { ProtocolBindingState } from "@teststand/contracts/projects";
import { BinaryIcon, ChevronRightIcon, FileCode2Icon, PencilIcon, PlusIcon, Unlink2Icon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { useMonitorStreams } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import { Button, IconButton, Input, PanelHeader, cn, useConfirm } from "../../ui/index.js";
import { useToast } from "../../ui/toast.js";
import { startStreamDrag } from "../monitor/use-monitor-workspace.js";
import { BindProtocolDialog } from "../protocols/BindProtocolDialog.js";
import { IcdEditorDialog } from "../protocols/IcdEditorDialog.js";
import { useProtocolBindings, useUpdateProtocols } from "../protocols/use-protocols.js";
import { useLatestValues, type LatestEntry } from "./use-latest-values.js";
import {
  deviceVariables, formatValue, liveKeys, VALUE_TYPES, type DeviceVariables, type RawVariable, type Variable
} from "./variable-model.js";

const TYPE_LABELS: Record<string, string> = {
  scalar: "模拟", bits: "位", bytes: "字节流", frames: "报文流", block: "采样块", blob: "文件", events: "事件"
};

type Binding = { hardwareId: string; streamId: string; streamType: string };

/**
 * 变量: every value the bench offers, with its live value. A device's own signals come first; under each raw
 * byte / frame stream are the protocols put on it (解析协议 binds one) and the fields they decode, which are
 * variables like the others. Any variable is dragged (or added with +) onto 运行监控.
 */
export function VariablesSidebar({ active, onAddStream }: {
  /** Shown: live values are polled only then. */
  active: boolean;
  onAddStream: (ref: StreamRef) => void;
}) {
  const streams = useMonitorStreams();
  const protocols = useProtocolBindings();
  const [filter, setFilter] = useState("");
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [binding, setBinding] = useState<Binding>();
  const devices = useMemo(
    () => (streams.data ?? []).map((device) => deviceVariables(device, protocols.data ?? [], filter)),
    [streams.data, protocols.data, filter]
  );
  const open = devices.filter((device) => !folded.has(device.hardwareId));
  const values = useLatestValues(liveKeys(open), active);
  const aliases = (protocols.data ?? []).map((item) => item.alias);
  const toggle = (hardwareId: string) => setFolded((current) => {
    const next = new Set(current);
    if (!next.delete(hardwareId)) next.add(hardwareId);
    return next;
  });

  return (
    <section aria-label="变量" className="flex h-full min-h-0 flex-col bg-surface-1">
      <PanelHeader title="变量" />
      <div className="shrink-0 border-b border-line p-1.5">
        <Input aria-label="筛选变量" placeholder="按名称筛选" value={filter}
          onChange={(event) => setFilter(event.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {streams.error && <p className="p-3 text-xs text-fail">读取数据流失败：{errorMessage(streams.error)}</p>}
        {!streams.isPending && !devices.length && (
          <p className="p-3 text-xs text-fg-3">还没有设备。先在「设备管理」里添加设备。</p>
        )}
        {devices.map((device) => (
          <DeviceGroup key={device.hardwareId} device={device} open={!folded.has(device.hardwareId)}
            values={values} onToggle={() => toggle(device.hardwareId)} onAdd={onAddStream}
            onBind={(raw) => setBinding({
              hardwareId: raw.hardwareId, streamId: raw.stream.id, streamType: String(raw.stream.type)
            })} />
        ))}
      </div>
      <ProtocolFiles />
      <p className="shrink-0 border-t border-line px-3 py-1.5 text-2xs text-fg-3">
        把变量拖到运行监控的组件上；字节流先「解析协议」才有字段变量
      </p>
      {binding && <BindProtocolDialog {...binding} aliases={aliases} onClose={() => setBinding(undefined)} />}
    </section>
  );
}

/** The project's protocols (ICD files): written here before any device is connected, bound to streams above. */
function ProtocolFiles() {
  const icds = useQuery({ queryKey: queryKeys.icds, queryFn: () => window.teststand.testing.listIcds() });
  const [editing, setEditing] = useState<{ name?: string }>();
  return (
    <section aria-label="协议" className="shrink-0 border-t border-line px-1.5 py-1">
      <header className="flex h-6 items-center gap-1.5 px-1">
        <FileCode2Icon className="size-3.5 text-fg-3" />
        <h3 className="text-xs font-medium text-fg">协议（ICD）</h3>
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={() => setEditing({})}><PlusIcon />新建协议</Button>
      </header>
      <ul className="max-h-32 overflow-y-auto">
        {(icds.data ?? []).map((item) => (
          <li key={item.name} className="group/icd flex h-6 items-center gap-1.5 pr-1 pl-6 text-2xs">
            <span className="truncate font-mono text-fg">{item.name}</span>
            <span className={cn("min-w-0 flex-1 truncate", item.valid ? "text-fg-3" : "text-fail")}
              title={item.valid ? item.description ?? undefined : item.error}>
              {item.valid ? item.description ?? "" : "无效"}
            </span>
            <IconButton label={`编辑协议 ${item.name}`} size="icon-xs" variant="ghost"
              className="invisible group-hover/icd:visible" onClick={() => setEditing({ name: item.name })}>
              <PencilIcon />
            </IconButton>
          </li>
        ))}
        {icds.isSuccess && !icds.data.length && (
          <li className="pl-6 text-2xs text-fg-3">还没有协议。没接设备也可以先写，贴入样本字节试解码。</li>
        )}
      </ul>
      {editing && <IcdEditorDialog {...editing} onClose={() => setEditing(undefined)} />}
    </section>
  );
}

function DeviceGroup({ device, open, values, onToggle, onAdd, onBind }: {
  device: DeviceVariables;
  open: boolean;
  values: ReadonlyMap<string, LatestEntry>;
  onToggle: () => void;
  onAdd: (ref: StreamRef) => void;
  onBind: (raw: RawVariable) => void;
}) {
  const empty = !device.signals.length && !device.raws.length;
  return (
    <div role="group" aria-label={device.label}>
      <button type="button" aria-expanded={open} onClick={onToggle}
        className="flex h-7 w-full items-center gap-1.5 px-1.5 text-left text-xs hover:bg-surface-2">
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-fg-3 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{device.label}</span>
        <span className="shrink-0 font-mono text-2xs text-fg-3">{device.hardwareId}</span>
      </button>
      {open && empty && (
        <p className="pb-1.5 pl-7 text-2xs text-fg-3">
          {device.known ? "没有匹配的变量" : "设备连接一次后显示它的数据流"}
        </p>
      )}
      {open && device.signals.map((item) => (
        <VariableRow key={item.key} item={item} depth={1} value={values.get(item.key)} onAdd={onAdd} />
      ))}
      {open && device.raws.map((raw) => (
        <RawGroup key={raw.key} raw={raw} values={values} onAdd={onAdd} onBind={() => onBind(raw)} />
      ))}
    </div>
  );
}

function RawGroup({ raw, values, onAdd, onBind }: {
  raw: RawVariable;
  values: ReadonlyMap<string, LatestEntry>;
  onAdd: (ref: StreamRef) => void;
  onBind: () => void;
}) {
  return (
    <div role="group" aria-label={`${raw.name} 及其协议字段`}>
      <VariableRow item={raw} depth={1} onAdd={onAdd}
        action={(
          <Button size="xs" variant="ghost" className="shrink-0" onClick={onBind}
            title="选一份协议（ICD）把这条流解析成字段变量">
            <BinaryIcon />解析协议
          </Button>
        )} />
      {raw.bindings.map((binding) => <BindingRow key={binding.alias} binding={binding} />)}
      {raw.fields.map((field) => (
        <VariableRow key={field.key} item={field} depth={2} value={values.get(field.key)} onAdd={onAdd} />
      ))}
    </div>
  );
}

/** One protocol on a raw stream: its ICD (editable here), or why it decodes nothing. */
function BindingRow({ binding }: { binding: ProtocolBindingState }) {
  const toast = useToast();
  const update = useUpdateProtocols();
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState(false);
  const unbind = async () => {
    if (!await confirm({
      title: "解除协议",
      message: `不再用 ${binding.icd} 解析这条流；字段变量 ${binding.alias}.* 会从面板和测试引用里失效。`,
      confirmLabel: "解除",
      danger: true
    })) return;
    update.mutate([{ op: "remove", alias: binding.alias }], {
      onError: (error) => toast.error(errorMessage(error))
    });
  };
  return (
    <div className="group/binding flex h-6 items-center gap-1.5 pr-1.5 pl-9 text-2xs">
      <FileCode2Icon className="size-3 shrink-0 text-fg-3" />
      <span className="truncate font-mono text-fg-2" title={`别名 ${binding.alias}，协议 ${binding.icd}`}>
        {binding.alias} · {binding.icd}
      </span>
      {!binding.ok && <span className="min-w-0 flex-1 truncate text-fail" title={binding.error}>{binding.error}</span>}
      <span className="flex-1" />
      <IconButton label={`编辑协议 ${binding.icd}`} size="icon-xs" variant="ghost"
        className="invisible group-hover/binding:visible" onClick={() => setEditing(true)}><PencilIcon /></IconButton>
      <IconButton label={`解除协议 ${binding.alias}`} size="icon-xs" variant="ghost"
        className="invisible group-hover/binding:visible" onClick={() => void unbind()}><Unlink2Icon /></IconButton>
      {editing && (
        <IcdEditorDialog name={binding.icd} alias={binding.alias} source={binding.source}
          onClose={() => setEditing(false)} />
      )}
      {confirmDialog}
    </div>
  );
}

function VariableRow({ item, depth, value, action, onAdd }: {
  item: Variable;
  depth: 1 | 2;
  value?: LatestEntry | undefined;
  action?: ReactNode;
  onAdd: (ref: StreamRef) => void;
}) {
  const ref = { hardwareId: item.hardwareId, streamId: item.stream.id };
  const type = String(item.stream.type);
  const live = VALUE_TYPES.has(type);
  const offline = value?.state && value.state.state !== "connected" && value.state.state !== "live";
  const onDragStart = (event: DragEvent) => startStreamDrag(event.dataTransfer, ref, type);
  return (
    <div draggable onDragStart={onDragStart} title={`${item.hardwareId}/${item.stream.id}：拖到运行监控的组件上`}
      className={cn("group/variable flex h-6 cursor-grab items-center gap-1.5 pr-1.5 text-2xs hover:bg-surface-2",
        depth === 1 ? "pl-7" : "pl-12")}>
      <span className="min-w-0 truncate text-fg">{item.name}</span>
      {item.name !== item.stream.id && <span className="min-w-0 truncate font-mono text-fg-3">{item.stream.id}</span>}
      <span className="flex-1" />
      {live ? (
        <span aria-label={`${item.name} 的当前值`}
          className={cn("shrink-0 font-mono tabular-nums", offline ? "text-fg-3" : "text-fg")}>
          {formatValue(value?.record?.v, type)}{item.unit && <span className="text-fg-3"> {item.unit}</span>}
        </span>
      ) : (
        <span className="shrink-0 text-fg-3">{TYPE_LABELS[type] ?? type}</span>
      )}
      {action}
      <IconButton label={`把 ${item.stream.id} 加到当前组件`} size="icon-xs" variant="ghost"
        className="invisible shrink-0 group-hover/variable:visible" onClick={() => onAdd(ref)}>
        <PlusIcon />
      </IconButton>
    </div>
  );
}
