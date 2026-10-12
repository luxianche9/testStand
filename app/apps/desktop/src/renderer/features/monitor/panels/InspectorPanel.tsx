import { useState, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ArrowUpIcon, PlusIcon, Settings2Icon, XIcon } from "lucide-react";
import type { MonitorPanel, StreamRef } from "@teststand/contracts/monitor";
import { Button, IconButton, Input, Select } from "../../../ui/index.js";
import { deviceName } from "../../streams/stream-model.js";
import { isNumber, isString, PanelFrame, settingOf, useMonitor, usePanel } from "../panel-kit.js";
import { PANEL_LABELS, panelTitle } from "../use-monitor-workspace.js";
import { PanelEmpty } from "./common.js";
import { fieldsOf, type BitField } from "./RegisterPanel.js";
import { limitsOf } from "./ValuesPanel.js";

/** A number field that saves when it loses focus (empty clears the setting). */
function NumberSetting({ label, value, onSave }: {
  label: string;
  value: number | undefined;
  onSave: (value: number | undefined) => void;
}) {
  const [text, setText] = useState<string>();
  return (
    <Input aria-label={label} className="tf-num h-6 w-20 text-2xs" inputMode="decimal" placeholder="—"
      value={text ?? (value === undefined ? "" : String(value))}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text === undefined) return;
        const parsed = Number(text);
        onSave(text.trim() === "" || !Number.isFinite(parsed) ? undefined : parsed);
        setText(undefined);
      }}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-fg-3">{label}</span>
      <span className="flex flex-wrap items-center gap-1">{children}</span>
    </div>
  );
}

type Limit = { lo?: number | undefined; hi?: number | undefined };

function LimitSettings({ panel, save }: { panel: MonitorPanel; save: (settings: Record<string, unknown>) => void }) {
  const setLimit = (ref: StreamRef, change: Limit) => {
    const all = panel.settings.limits && typeof panel.settings.limits === "object"
      ? panel.settings.limits as Record<string, unknown> : {};
    const next = { ...limitsOf(panel.settings, ref), ...change };
    const clean = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
    save({ limits: { ...all, [`${ref.hardwareId}/${ref.streamId}`]: clean } });
  };
  return (
    <section className="grid gap-1">
      <h3 className="text-2xs font-normal text-fg-3">告警限（越限显示为红色）</h3>
      {panel.sources.map((ref) => {
        const limits = limitsOf(panel.settings, ref);
        return (
          <Row key={`${ref.hardwareId}/${ref.streamId}`} label={ref.streamId}>
            <NumberSetting label={`${ref.streamId} 下限`} value={limits.lo} onSave={(lo) => setLimit(ref, { lo })} />
            <span className="text-fg-3">~</span>
            <NumberSetting label={`${ref.streamId} 上限`} value={limits.hi} onSave={(hi) => setLimit(ref, { hi })} />
          </Row>
        );
      })}
    </section>
  );
}

function GaugeSettings({ panel, save }: { panel: MonitorPanel; save: (settings: Record<string, unknown>) => void }) {
  const number = (key: string) => settingOf<number | undefined>(panel, key, undefined, isNumber);
  return (
    <section className="grid gap-1">
      <Row label="外观">
        <Select aria-label="仪表外观" className="h-6 text-2xs" value={settingOf(panel, "style", "dial", isString)}
          onChange={(event) => save({ style: event.target.value })}>
          <option value="dial">表盘</option>
          <option value="bar">条形</option>
          <option value="number">大数字</option>
        </Select>
      </Row>
      <Row label="量程">
        <NumberSetting label="量程最小" value={number("min")} onSave={(min) => save({ min: min ?? null })} />
        <span className="text-fg-3">~</span>
        <NumberSetting label="量程最大" value={number("max")} onSave={(max) => save({ max: max ?? null })} />
      </Row>
    </section>
  );
}

function FieldSettings({ panel, save }: { panel: MonitorPanel; save: (settings: Record<string, unknown>) => void }) {
  const [fields, setFields] = useState<BitField[]>(() => fieldsOf(panel.settings));
  const change = (index: number, patch: Partial<BitField>) =>
    setFields(fields.map((item, at) => (at === index ? { ...item, ...patch } : item)));
  return (
    <section className="grid gap-1">
      <h3 className="text-2xs font-normal text-fg-3">位域（最低位 + 位数）</h3>
      {fields.map((field, index) => (
        <div key={index} className="flex items-center gap-1">
          <Input aria-label="位域名称" className="h-6 w-24 text-2xs" value={field.name}
            onChange={(event) => change(index, { name: event.target.value })} />
          <Input aria-label="最低位" type="number" className="h-6 w-14 text-2xs" value={field.lsb}
            onChange={(event) => change(index, { lsb: Number(event.target.value) })} />
          <Input aria-label="位数" type="number" className="h-6 w-14 text-2xs" value={field.width}
            onChange={(event) => change(index, { width: Math.max(1, Number(event.target.value)) })} />
          <IconButton label="删除位域" size="icon-xs" variant="ghost"
            onClick={() => setFields(fields.filter((_, at) => at !== index))}>
            <XIcon />
          </IconButton>
        </div>
      ))}
      <span className="flex gap-1">
        <Button size="xs" variant="ghost"
          onClick={() => setFields([...fields, { name: `F${fields.length}`, lsb: 0, width: 1 }])}>
          <PlusIcon />位域
        </Button>
        <Button size="xs" variant="outline" onClick={() => save({ fields: fields.filter((item) => item.name.trim()) })}>
          保存位域
        </Button>
      </span>
    </section>
  );
}

function Settings({ panel }: { panel: MonitorPanel }) {
  const { workspace } = useMonitor();
  const save = (settings: Record<string, unknown>) => workspace.updatePanel(panel.id, { settings });
  return (
    <>
      {(panel.type === "values" || panel.type === "gauge") && panel.sources.length > 0 && (
        <LimitSettings panel={panel} save={save} />
      )}
      {panel.type === "gauge" && <GaugeSettings panel={panel} save={save} />}
      {panel.type === "register" && <FieldSettings panel={panel} save={save} />}
      {panel.type === "trace" && <p className="text-fg-3">显示方式和 ICD 在面板自己的工具栏里设置。</p>}
      {panel.type === "scope" && (
        <p className="text-fg-3">垂直档位、显示方式在示波器工具栏里设置；水平时基在标题栏，所有面板共用。</p>
      )}
      {panel.type === "xy" && <p className="text-fg-3">第一个流是 X，第二个是 Y；用 ↑ 调整顺序。</p>}
    </>
  );
}

/**
 * The selected panel's settings (Rerun's selection panel), so panels themselves stay clean:
 * title, its streams in order, and what its type can be told — limits, gauge style and range,
 * bit fields.
 */
export function InspectorPanel({ api }: IDockviewPanelProps) {
  const [{ workspace, activePanelId }, self] = usePanel(api.id);
  const panel = workspace.monitor.panels.find((item) => item.id === activePanelId && item.id !== api.id);
  const [title, setTitle] = useState<string>();
  if (!self) return null;
  if (!panel) {
    return <PanelFrame panel={self}><PanelEmpty icon={<Settings2Icon />} text="点一个面板，这里显示它的设置" /></PanelFrame>;
  }
  const move = (index: number) => {
    const sources = [...panel.sources];
    const [item] = sources.splice(index, 1);
    if (item) sources.splice(index - 1, 0, item);
    workspace.setSources(panel.id, sources);
  };
  return (
    <PanelFrame panel={self} className="grid content-start gap-2 overflow-auto p-2 text-2xs" key={panel.id}>
      <Row label="面板">{PANEL_LABELS[panel.type]} · <span className="font-mono text-fg-3">{panel.id}</span></Row>
      <Row label="标题">
        <Input aria-label="面板标题" className="h-6 text-2xs" value={title ?? panelTitle(panel)}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => { if (title !== undefined) workspace.updatePanel(panel.id, { title }); setTitle(undefined); }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      </Row>
      {panel.sources.length > 0 && (
        <section className="grid gap-0.5">
          <h3 className="text-2xs font-normal text-fg-3">数据流（{panel.sources.length}）</h3>
          {panel.sources.map((ref, index) => (
            <div key={`${ref.hardwareId}/${ref.streamId}`} className="flex h-5 items-center gap-1">
              <span className="truncate font-mono text-fg">{ref.streamId}</span>
              <span className="truncate text-fg-3">{deviceName(ref.hardwareId)}</span>
              <IconButton label={`上移 ${ref.streamId}`} size="icon-xs" variant="ghost" className="ml-auto"
                disabled={index === 0} onClick={() => move(index)}>
                <ArrowUpIcon />
              </IconButton>
              <IconButton label={`移除 ${ref.streamId}`} size="icon-xs" variant="ghost"
                onClick={() => workspace.removeFrom(panel.id, ref)}>
                <XIcon />
              </IconButton>
            </div>
          ))}
        </section>
      )}
      <Settings key={panel.id} panel={panel} />
    </PanelFrame>
  );
}
