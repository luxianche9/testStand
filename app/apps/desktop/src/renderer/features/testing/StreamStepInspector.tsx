import { useQuery } from "@tanstack/react-query";
import type { Hardware } from "@teststand/contracts/devices";
import type {
  TestExpressionReference, TestPlan, TestStep, TestStepCatalogItem
} from "@teststand/contracts/testing";
import { Field, Select } from "../../ui";
import { queryKeys } from "../../lib/query-keys.js";
import { schemaProperties, stripSchemaProperties, type JsonSchema } from "../manual/schema-form-model.js";
import { planAnchors } from "./plan-model.js";
import { StepSettingsForm } from "./TestPlanForms.js";

/**
 * Observe / Expect / Guard: pick the device, one of its streams and (Observe / Expect) the anchor an
 * earlier tool call sets; the judging settings come from the catalog schema.
 */
export function StreamStepInspector({ plan, step, hardware, catalogItem, references, update }: {
  plan: TestPlan;
  step: TestStep;
  hardware: Hardware[];
  catalogItem: TestStepCatalogItem | undefined;
  references: TestExpressionReference[];
  update: (patch: Record<string, unknown>) => void;
}) {
  const hardwareId = step.hardwareId ?? "";
  const streamId = stringOf(step.streamId);
  const streams = useQuery({
    queryKey: queryKeys.deviceStreams(hardwareId),
    queryFn: () => window.teststand.streams.listStreams({ hardwareId }),
    enabled: Boolean(hardwareId)
  });
  const streamIds = withCurrent((streams.data ?? []).map((stream) => stream.id), streamId);
  const types = new Map((streams.data ?? []).map((stream) => [stream.id, String(stream.type)]));
  const observe = step.type === "Observe";
  const timeWindow = observe && isRecord(step.window) ? step.window : {};
  const anchor = observe ? stringOf(timeWindow.anchor) : stringOf(step.anchor);
  const anchors = withCurrent(planAnchors(plan).map((item) => item.name), anchor);
  const setAnchor = (value: string) =>
    update(observe ? { window: { ...timeWindow, anchor: value } } : { anchor: value });

  return (
    <>
      <Field label="具体设备" required>
        <Select
          value={hardwareId}
          onChange={(event) => update({ hardwareId: event.target.value, streamId: undefined })}
        >
          <option value="">选择 managed hardware</option>
          {hardware.filter((item) => item.kind === "managed").map((item) => (
            <option key={item.hardwareId} value={item.hardwareId}>{item.label} · {item.hardwareId}</option>
          ))}
        </Select>
      </Field>
      <Field
        label="数据流"
        required
        {...(streams.error ? { hint: "读取设备数据流失败，服务未运行时只能保留已填写的数据流。" } : {})}
      >
        <Select
          value={streamId}
          disabled={!hardwareId}
          onChange={(event) => update({ streamId: event.target.value || undefined })}
        >
          <option value="">选择数据流</option>
          {streamIds.map((id) => (
            <option key={id} value={id}>{types.has(id) ? `${id} · ${types.get(id)}` : id}</option>
          ))}
        </Select>
      </Field>
      {step.type !== "Guard" && (
        <Field label="锚点" required hint="在「调用设备工具」步骤的锚点名中定义，窗口时间相对它的完成时刻。">
          <Select value={anchor} onChange={(event) => setAnchor(event.target.value)}>
            <option value="">选择锚点</option>
            {anchors.map((name) => <option key={name} value={name}>{name}</option>)}
          </Select>
        </Field>
      )}
      <StepSettingsForm
        step={step}
        {...(catalogItem
          ? { catalogItem: { ...catalogItem, settingsSchema: settingsWithoutPickers(catalogItem) } }
          : {})}
        references={references}
        onChange={update}
      />
    </>
  );
}

/** The catalog schema minus the fields picked above (the anchor of an Observe lives in `window`). */
function settingsWithoutPickers(item: TestStepCatalogItem): JsonSchema {
  const schema = stripSchemaProperties(item.settingsSchema as JsonSchema, ["streamId", "anchor"]);
  const properties = schemaProperties(schema);
  const timeWindow = properties?.window;
  if (!properties || !timeWindow) return schema;
  return { ...schema, properties: { ...properties, window: stripSchemaProperties(timeWindow, ["anchor"]) } };
}

function withCurrent(values: string[], current: string | undefined): string[] {
  return current && !values.includes(current) ? [...values, current] : values;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
