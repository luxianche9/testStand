import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { CheckIcon, PlayIcon, PlusIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import type { ToolCatalogItem } from "@teststand/contracts/devices";
import { CONTROL_WIDGETS, type ControlWidget, type MonitorControl } from "@teststand/contracts/monitor";
import { errorMessage } from "../../../lib/errors.js";
import {
  Button, cn, Dialog, DialogBody, DialogContent, DialogFooter, IconButton, Input, Select, Spinner
} from "../../../ui/index.js";
import { actionKind, actionName } from "../../bench/device-actions.js";
import { SchemaArgumentsForm } from "../../manual/SchemaForm.js";
import { initialSchemaValue, stripSchemaProperties, type JsonSchema } from "../../manual/schema-form-model.js";
import { widgetFor } from "../../manual/widget-model.js";
import { NumberControl, Segmented, ToggleSwitch, ToolFieldContext } from "../../manual/widgets.js";
import { deviceName } from "../../streams/stream-model.js";
import { useControlRequest } from "../control-requests.js";
import { PanelFrame, useMonitor, usePanel } from "../panel-kit.js";
import { PanelEmpty } from "./common.js";

function controlsOf(settings: Record<string, unknown>): MonitorControl[] {
  const value = settings.controls;
  return Array.isArray(value) ? value.filter((item): item is MonitorControl =>
    Boolean(item) && typeof item === "object" && typeof (item as MonitorControl).tool === "string") : [];
}

const WIDGET_LABELS: Record<ControlWidget, string> = { button: "按钮", toggle: "开关", slider: "滑块", presets: "预置值" };

function propertiesOf(tool: ToolCatalogItem | undefined): Record<string, JsonSchema> {
  return (tool?.inputSchema.properties ?? {}) as Record<string, JsonSchema>;
}

/** The widget a parameter suits best: a switch for a boolean, a slider for a number, else presets. */
function suggestedWidget(schema: JsonSchema | undefined): ControlWidget {
  if (!schema) return "button";
  if (schema.type === "boolean") return "toggle";
  if (schema.type === "number" || schema.type === "integer") return "slider";
  return "presets";
}

/** "0, 1.65, abc" → [0, 1.65, "abc"]. */
function presetValues(text: string): (string | number)[] {
  return text.split(/[,，\s]+/).filter(Boolean).map((item) => (Number.isFinite(Number(item)) ? Number(item) : item));
}

type Outcome = { ok: boolean; message: string } | undefined;

/** One control: calls its tool with the fixed arguments and the operator's value. */
function Control({ control, onRemove }: { control: MonitorControl; onRemove: () => void }) {
  const { control: manual } = useMonitor();
  const [value, setValue] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const tool = manual.findTool(control.hardwareId, control.tool);
  const locked = manual.lockOf(control.hardwareId);
  const schema = control.param ? propertiesOf(tool)[control.param] : undefined;
  const disabled = Boolean(locked) || !tool || busy;
  const run = async (next?: unknown) => {
    setBusy(true);
    try {
      const args = { ...control.fixed, ...(control.param && next !== undefined ? { [control.param]: next } : {}) };
      const result = await manual.call(control.hardwareId, control.tool, args);
      setOutcome({ ok: true, message: JSON.stringify(result.output) });
    } catch (cause) {
      setOutcome({ ok: false, message: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };
  const widget = schema ? widgetFor(control.param ?? "", schema) : undefined;
  const numeric = widget?.kind === "number" ? widget : undefined;
  const kind = tool ? actionKind(tool) : undefined;
  const name = control.label || (tool ? actionName(tool, manual.toolsOf(control.hardwareId)) : control.tool);
  const fixedText = Object.entries(control.fixed).map(([key, item]) => `${key}=${JSON.stringify(item)}`).join(" ");
  const numbers = control.presets?.every((item) => typeof item === "number") ? control.presets as number[] : undefined;
  return (
    <figure className={cn("m-0 grid content-start gap-1.5 rounded-sm border bg-surface-1 p-2",
      kind?.tone === "signal" ? "border-signal/40" : "border-line")}>
      <figcaption className="group/control flex items-center gap-1.5">
        <span className="truncate text-xs text-fg">{name}</span>
        <span className="truncate text-2xs text-fg-3">{deviceName(control.hardwareId)}</span>
        {busy && <Spinner />}
        <IconButton label={`删除控件 ${name}`} size="icon-xs" variant="ghost"
          className="ml-auto opacity-0 group-hover/control:opacity-100 focus-visible:opacity-100" onClick={onRemove}>
          <XIcon />
        </IconButton>
      </figcaption>
      {fixedText && <span className="truncate font-mono text-2xs text-fg-3" title={fixedText}>{fixedText}</span>}
      {control.widget === "button" && (
        <Button size="xs" variant={kind?.tone === "signal" ? "primary" : "outline"} disabled={disabled}
          onClick={() => void run()}>
          <PlayIcon />执行
        </Button>
      )}
      {control.widget === "toggle" && (
        <ToggleSwitch checked={value === true} label={name} disabled={disabled}
          {...(widget?.kind === "toggle" ? { on: widget.on, off: widget.off } : {})}
          onChange={(next) => { setValue(next); void run(next); }} />
      )}
      {control.widget === "slider" && (
        <NumberControl value={typeof value === "number" ? value : undefined} label={name} disabled={disabled}
          widget={{
            kind: "number", integer: numeric?.integer ?? false, step: numeric?.step ?? 0.01,
            min: control.min ?? numeric?.min, max: control.max ?? numeric?.max,
            ...(numeric?.unit ? { unit: numeric.unit } : {})
          }}
          {...(numbers ? { presets: numbers } : {})}
          onChange={setValue} onCommit={(next) => void run(next)} />
      )}
      {control.widget === "presets" && (
        <Segmented label={name} value={value} disabled={disabled}
          options={(control.presets ?? []).filter((item): item is string | number =>
            typeof item === "string" || typeof item === "number")}
          onChange={(next) => { setValue(next); void run(next); }} />
      )}
      {locked && <span className="text-2xs text-fail">{locked}，不能手动控制</span>}
      {!tool && !locked && <span className="text-2xs text-fail">设备离线或没有工具 {control.tool}</span>}
      {outcome && (
        <span title={outcome.message}
          className={cn("flex items-start gap-1 truncate font-mono text-2xs", outcome.ok ? "text-pass" : "text-fail")}>
          {outcome.ok ? <CheckIcon className="size-3 shrink-0" /> : <XIcon className="size-3 shrink-0" />}
          <span className="truncate">{outcome.message}</span>
        </span>
      )}
    </figure>
  );
}

/** Picks a device tool, the argument the operator sets, the fixed ones and the widget. */
/** The parameter a widget sets: a boolean for a switch, a number for a slider, none for a button. */
function paramFor(widget: ControlWidget, props: Record<string, JsonSchema>): string | undefined {
  const names = Object.keys(props);
  const typed = (types: string[]) => names.find((name) => types.includes(String(props[name]?.type)));
  if (widget === "button") return undefined;
  if (widget === "toggle") return typed(["boolean"]) ?? typed(["integer"]);
  if (widget === "slider") return typed(["number"]) ?? typed(["integer"]);
  return typed(["number", "integer", "string"]);
}

function AddControlDialog({ open, widgetWanted, onClose, onAdd }: {
  open: boolean;
  /** The widget asked for (dropped from the component sidebar); otherwise suggested by the tool. */
  widgetWanted: ControlWidget | undefined;
  onClose: () => void;
  onAdd: (control: Omit<MonitorControl, "id">) => void;
}) {
  const { workspace, control: manual } = useMonitor();
  const devices = workspace.devices.filter((device) => manual.toolsOf(device.hardwareId).length);
  const [hardwareId, setHardwareId] = useState<string>();
  const [toolName, setToolName] = useState<string>();
  const [param, setParam] = useState<string>();
  const [widget, setWidget] = useState<ControlWidget>("button");
  const [fixed, setFixed] = useState<Record<string, unknown>>({});
  const [label, setLabel] = useState("");
  const [presets, setPresets] = useState("");
  const device = hardwareId ?? devices[0]?.hardwareId;
  const tools = device ? manual.toolsOf(device) : [];
  const tool = tools.find((item) => item.remoteName === toolName) ?? tools[0];
  const properties = propertiesOf(tool);
  const fixedSchema = useMemo(() => (tool ? stripSchemaProperties(tool.inputSchema, param ? [param] : []) : {}),
    [tool, param]);
  const pickTool = (name: string | undefined) => {
    const next = tools.find((item) => item.remoteName === name) ?? tools[0];
    const props = propertiesOf(next);
    const free = widgetWanted ? paramFor(widgetWanted, props)
      : Object.keys(props).find((item) => ["boolean", "number"].includes(String(props[item]?.type)));
    setToolName(next?.remoteName);
    setParam(free);
    setWidget(widgetWanted && (widgetWanted === "button") === !free ? widgetWanted
      : suggestedWidget(free ? props[free] : undefined));
    const initial = next ? initialSchemaValue(stripSchemaProperties(next.inputSchema, free ? [free] : [])) : {};
    setFixed(initial as Record<string, unknown>);
  };
  useEffect(() => {
    if (open && tool) pickTool(tool.remoteName);
  }, [open, tool?.remoteName, widgetWanted]); // eslint-disable-line react-hooks/exhaustive-deps
  const values = presetValues(presets);
  const add = () => {
    if (!device || !tool) return;
    onAdd({
      hardwareId: device, tool: tool.remoteName, widget, fixed,
      ...(param ? { param } : {}), ...(label.trim() ? { label: label.trim() } : {}),
      ...(values.length ? { presets: values } : {})
    });
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent title="添加控件" size="md">
        <DialogBody className="grid gap-2.5 text-xs">
          <label className="grid gap-1">设备
            <Select aria-label="设备" value={device ?? ""}
              onChange={(event) => { setHardwareId(event.target.value); setToolName(undefined); }}>
              {devices.map((item) => (
                <option key={item.hardwareId} value={item.hardwareId}>{item.label || item.hardwareId}</option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1">工具
            <Select aria-label="工具" value={tool?.remoteName ?? ""} onChange={(event) => pickTool(event.target.value)}>
              {tools.map((item) => (
                <option key={item.remoteName} value={item.remoteName}>
                  {actionName(item, tools)} · {actionKind(item).label}
                </option>
              ))}
            </Select>
          </label>
          {tool?.description && <p className="text-2xs text-fg-3">{tool.description}</p>}
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1">由操作员设定的参数
              <Select aria-label="设定的参数" value={param ?? ""} onChange={(event) => {
                const next = event.target.value || undefined;
                setParam(next);
                setWidget(next ? suggestedWidget(properties[next]) : "button");
              }}>
                <option value="">无（按钮）</option>
                {Object.keys(properties).map((name) => <option key={name} value={name}>{name}</option>)}
              </Select>
            </label>
            <label className="grid gap-1">控件
              <Select aria-label="控件类型" value={widget}
                onChange={(event) => setWidget(event.target.value as ControlWidget)}>
                {CONTROL_WIDGETS.filter((item) => (item === "button") === !param).map((item) => (
                  <option key={item} value={item}>{WIDGET_LABELS[item]}</option>
                ))}
              </Select>
            </label>
          </div>
          {(widget === "presets" || widget === "slider") && (
            <label className="grid gap-1">预置值（逗号分隔）
              <Input aria-label="预置值" value={presets} placeholder="0, 1.65, 3.3"
                onChange={(event) => setPresets(event.target.value)} />
            </label>
          )}
          <label className="grid gap-1">名称
            <Input aria-label="控件名称" value={label} placeholder={tool ? actionName(tool, tools) : ""}
              onChange={(event) => setLabel(event.target.value)} />
          </label>
          {tool && Object.keys((fixedSchema.properties ?? {}) as object).length > 0 && (
            <fieldset className="grid gap-2 rounded-sm border border-line p-2">
              <legend className="px-1 text-2xs text-fg-3">固定参数</legend>
              <ToolFieldContext.Provider value={{ ...(device ? { hardwareId: device } : {}), tool: tool.remoteName }}>
                <SchemaArgumentsForm schema={fixedSchema} value={fixed} onChange={setFixed} />
              </ToolFieldContext.Provider>
            </fieldset>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!device || !tool || (widget === "presets" && !values.length)}
            onClick={add}>
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The operator's own front panel (CANoe Panel Designer, FUXA): buttons, switches, sliders and
 * preset buttons bound to device tools with some arguments fixed, e.g. "AO0 = slider" or
 * "K5 closed / open". Disabled for a device a test run holds. The Agent can build it too.
 */
export function ControlPanel({ api }: IDockviewPanelProps) {
  const [{ workspace, control }, panel] = usePanel(api.id);
  const [adding, setAdding] = useState(false);
  const [requested, requestDone] = useControlRequest(api.id);
  if (!panel) return null;
  const controls = controlsOf(panel.settings);
  return (
    <PanelFrame panel={panel} className="flex flex-col">
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-2 text-2xs text-fg-3">
        <Button size="xs" variant="ghost" onClick={() => setAdding(true)}><PlusIcon />添加控件</Button>
        {control.running && <span className="text-fail">测试运行中：运行占用的设备不能手动控制</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {!controls.length ? (
          <PanelEmpty icon={<SlidersHorizontalIcon />} text="添加控件：把常用的设备动作做成按钮、开关或滑块" />
        ) : (
          <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
            {controls.map((item) => (
              <Control key={item.id} control={item} onRemove={() => workspace.removeControl(panel.id, item.id)} />
            ))}
          </div>
        )}
      </div>
      {control.history.length > 0 && (
        <details className="shrink-0 border-t border-line bg-surface-1 text-2xs">
          <summary className="cursor-pointer px-2 py-0.5 text-fg-3">操作记录 {control.history.length}</summary>
          <ol className="max-h-32 overflow-auto px-2 pb-1 font-mono">
            {control.history.map((call) => (
              <li key={call.id} className={cn("truncate", call.ok ? "text-fg-2" : "text-fail")} title={call.message}>
                {new Date(call.at).toLocaleTimeString()} {deviceName(call.hardwareId)}.{call.tool}
                {" "}{JSON.stringify(call.args)} → {call.message}
              </li>
            ))}
          </ol>
        </details>
      )}
      <AddControlDialog open={adding || requested !== undefined} widgetWanted={requested}
        onClose={() => { setAdding(false); requestDone(); }}
        onAdd={(item) => workspace.addControl(panel.id, item)} />
    </PanelFrame>
  );
}
