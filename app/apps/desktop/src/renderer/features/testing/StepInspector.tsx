import { useEffect, useState } from "react";
import type { Hardware } from "@teststand/contracts/devices";
import type {
  TestExpressionReference, TestPlan, TestStep, TestStepCatalogItem
} from "@teststand/contracts/testing";
import { XIcon } from "lucide-react";
import { Badge, Button, Checkbox, Field, IconButton, Input, Section, Select, Textarea } from "../../ui";
import { useTestDeviceTools } from "../../lib/queries.js";
import { stripSchemaProperties, type JsonSchema } from "../manual/schema-form-model.js";
import { collectRequirementSteps, schemaFieldPaths } from "./plan-helpers.js";
import { findStep } from "./plan-model.js";
import { DeviceBindingsEditor } from "./DeviceBindings.js";
import { ProtocolBindingsEditor } from "./ProtocolBindings.js";
import { StreamStepInspector } from "./StreamStepInspector.js";
import { BoundArgumentsForm, PlanParametersEditor, StepSettingsForm } from "./TestPlanForms.js";

/** InvokeTool settings with their own controls above the schema form. */
const invokeFieldsAbove = ["timeoutMs", "errorPolicy"];
/** Steps that judge a device stream (see `STREAM_STEPS` in the backend models). */
const streamStepTypes = new Set(["Observe", "Expect", "Guard"]);

type Mutate = (change: (next: TestPlan) => void) => void;
type Bind = (stepId: string, hardwareId: string, toolName: string, refresh?: boolean) => Promise<void>;

/** 属性 tab: plan properties when no step is selected, otherwise the selected step's settings. */
export function StepInspector({ plan, step, hardware, catalogItem, references, consumers, mutate, update,
  onSelectStep, onBind }: {
  plan: TestPlan;
  step: TestStep | undefined;
  hardware: Hardware[];
  catalogItem: TestStepCatalogItem | undefined;
  references: TestExpressionReference[];
  consumers: string[];
  mutate: Mutate;
  update: (stepId: string, patch: Record<string, unknown>) => void;
  /** Selects another step; `undefined` returns to the plan properties. */
  onSelectStep: (stepId: string | undefined) => void;
  onBind: Bind;
}) {
  if (!step) return <PlanInspector plan={plan} hardware={hardware} mutate={mutate} />;
  const patch = (value: Record<string, unknown>) => update(step.id, value);
  const reveal = (stepId: string) => {
    onSelectStep(stepId);
    const selector = `[data-step-id="${globalThis.CSS.escape(stepId)}"]`;
    document.querySelector<HTMLElement>(selector)?.scrollIntoView?.({ block: "center" });
  };
  return (
    <div className="grid gap-3 p-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <Badge>{catalogItem?.label ?? step.type}</Badge>
        {step.hardwareId && <Badge mono tone="signal">{step.hardwareId}</Badge>}
        <code className="ml-auto truncate text-2xs text-fg-3" title="在其他步骤的表达式中用它引用本步骤输出">
          steps.{step.id}
        </code>
        <IconButton label="返回计划属性" size="icon-xs" onClick={() => onSelectStep(undefined)}><XIcon /></IconButton>
      </div>
      <Field label="步骤名称">
        <Input value={step.name ?? ""} onChange={(event) => patch({ name: event.target.value })} />
      </Field>
      {step.type === "InvokeTool" ? (
        <InvokeInspector
          step={step}
          hardware={hardware}
          catalogItem={catalogItem}
          references={references}
          update={patch}
          onBind={onBind}
        />
      ) : streamStepTypes.has(step.type) ? (
        <StreamStepInspector
          plan={plan}
          step={step}
          hardware={hardware}
          catalogItem={catalogItem}
          references={references}
          update={patch}
        />
      ) : (
        <StepSettingsForm
          step={step}
          {...(catalogItem ? { catalogItem } : {})}
          references={references}
          onChange={patch}
        />
      )}
      <label className="flex items-center gap-2 text-xs text-fg-2">
        <Checkbox
          checked={step.stopOnFail === true}
          onCheckedChange={(checked) => patch({ stopOnFail: checked === true })}
        />
        此步骤失败时停止所在组
      </label>
      {consumers.length > 0 && (
        <Section title="被以下步骤引用">
          <div className="grid gap-0.5">
            {consumers.map((stepId) => (
              <button
                key={stepId}
                type="button"
                className="truncate text-left text-xs text-signal hover:underline"
                onClick={() => reveal(stepId)}
              >
                {findStep(plan, stepId)?.step.name ?? stepId}
              </button>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function PlanInspector({ plan, hardware, mutate }: { plan: TestPlan; hardware: Hardware[]; mutate: Mutate }) {
  const covered = collectRequirementSteps(plan);
  return (
    <div className="grid gap-3 p-3">
      <Field label="计划名称">
        <Input value={plan.name} onChange={(event) => mutate((next) => { next.name = event.target.value; })} />
      </Field>
      <Field label="说明">
        <Textarea
          value={plan.description}
          onChange={(event) => mutate((next) => { next.description = event.target.value; })}
        />
      </Field>
      <Field label="运行参数">
        <PlanParametersEditor
          value={plan.parameters}
          onChange={(parameters) => mutate((next) => { next.parameters = parameters; })}
        />
      </Field>
      <label className="flex items-center gap-2 text-xs text-fg-2">
        <Checkbox
          checked={plan.stopOnFail}
          onCheckedChange={(checked) => mutate((next) => { next.stopOnFail = checked === true; })}
        />
        任一步骤失败时停止
      </label>
      <Field label="协议绑定" hint="用 ICD 解码设备的原始数据流；步骤以「别名.报文.字段」引用解出的数据流。">
        <ProtocolBindingsEditor
          value={plan.protocolBindings ?? []}
          hardware={hardware}
          onChange={(bindings) => mutate((next) => {
            if (bindings.length) next.protocolBindings = bindings;
            else delete next.protocolBindings;
          })}
        />
      </Field>
      <Field label="设备绑定" hint="步骤可用绑定名代替设备；${参数} 取运行参数，批量运行时按工位展开。">
        <DeviceBindingsEditor
          value={plan.bindings ?? {}}
          hardware={hardware}
          onChange={(bindings) => mutate((next) => {
            if (Object.keys(bindings).length) next.bindings = bindings;
            else delete next.bindings;
          })}
        />
      </Field>
      {plan.requirements.length > 0 && (
        <Field label="验收项">
          <ul className="grid gap-1">
            {plan.requirements.map((requirement) => {
              const steps = covered[requirement.id] ?? [];
              return (
                <li
                  key={requirement.id}
                  className="flex min-h-7 items-center gap-2 rounded-sm border border-line bg-surface-0 px-2 text-xs"
                  title={requirement.description}
                >
                  <span className="min-w-0 flex-1 truncate text-fg">{requirement.name}</span>
                  {steps.length
                    ? <span className="flex-none text-2xs text-fg-3" title={steps.join("、")}>{steps.length} 个步骤</span>
                    : <Badge tone="invalid">未关联步骤</Badge>}
                </li>
              );
            })}
          </ul>
        </Field>
      )}
    </div>
  );
}

function InvokeInspector({ step, hardware, catalogItem, references, update, onBind }: {
  step: TestStep;
  hardware: Hardware[];
  catalogItem: TestStepCatalogItem | undefined;
  references: TestExpressionReference[];
  update: (patch: Record<string, unknown>) => void;
  onBind: Bind;
}) {
  const [hardwareId, setHardwareId] = useState(step.hardwareId ?? "");
  useEffect(() => setHardwareId(step.hardwareId ?? ""), [step.id, step.hardwareId]);
  const tools = useTestDeviceTools(hardwareId);
  const selected = tools.data?.tools.find((tool) => tool.toolName === step.toolName);
  const outputPaths = selected ? schemaFieldPaths(selected.resultSchema) : [];
  return (
    <>
      <Field label="具体设备" required>
        <Select value={hardwareId} onChange={(event) => setHardwareId(event.target.value)}>
          <option value="">选择 managed hardware</option>
          {hardware.filter((item) => item.kind === "managed").map((item) => (
            <option key={item.hardwareId} value={item.hardwareId}>{item.label} · {item.hardwareId}</option>
          ))}
        </Select>
      </Field>
      <Field label="原始工具名" required>
        <Select
          value={hardwareId === step.hardwareId ? step.toolName ?? "" : ""}
          disabled={!hardwareId}
          onChange={(event) => { if (event.target.value) void onBind(step.id, hardwareId, event.target.value); }}
        >
          <option value="">选择设备工具</option>
          {(tools.data?.tools ?? []).map((tool) => (
            <option key={tool.toolName} value={tool.toolName}>{tool.toolName}</option>
          ))}
        </Select>
      </Field>
      <Field label="超时 (ms)">
        <Input
          type="number"
          min={1}
          className="tf-num"
          value={Number(step.timeoutMs ?? 30_000)}
          onChange={(event) => update({ timeoutMs: Number(event.target.value) })}
        />
      </Field>
      <Field label="错误策略">
        <Select
          value={String(step.errorPolicy ?? "error")}
          onChange={(event) => update({ errorPolicy: event.target.value })}
        >
          <option value="error">记录 Error 并进入清理</option>
          <option value="fail">已知结果错误转为 Fail 并继续</option>
        </Select>
      </Field>
      {catalogItem && (
        <StepSettingsForm
          step={step}
          catalogItem={{
            ...catalogItem,
            settingsSchema: stripSchemaProperties(catalogItem.settingsSchema as JsonSchema, invokeFieldsAbove)
          }}
          references={references}
          onChange={update}
        />
      )}
      {selected && (
        <>
          <Section title="参数绑定">
            <BoundArgumentsForm
              schema={selected.inputSchema as JsonSchema}
              value={step.arguments ?? {}}
              references={references}
              onChange={(value) => update({ arguments: value })}
            />
          </Section>
          <Section title="可引用输出字段">
            <code className="block font-mono text-2xs break-all text-fg-3">
              {outputPaths.join(" · ") || "Schema 未声明确定字段"}
            </code>
          </Section>
        </>
      )}
      {step.bindingRevision && (
        <div className="grid gap-1">
          <code className="font-mono text-2xs break-all text-fg-3">binding {step.bindingRevision}</code>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void onBind(step.id, step.hardwareId!, step.toolName!, true)}
          >
            显式重新绑定
          </Button>
        </div>
      )}
    </>
  );
}
