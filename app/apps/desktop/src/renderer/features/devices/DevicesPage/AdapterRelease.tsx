import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AdapterEvidence, AdapterReleaseGate, AdapterReleaseRecord, AdapterStatus
} from "@teststand/contracts/devices";
import { errorMessage } from "../../../lib/errors.js";
import { useAdapterStatus } from "../../../lib/queries.js";
import { queryKeys } from "../../../lib/query-keys.js";
import { Badge, Button, Field, Input, Section, Textarea } from "../../../ui";
import type { ReportError } from "./DeviceActions.js";

const gateLabels: Record<AdapterReleaseGate, string> = {
  check: "--check 自检",
  simulator: "模拟器测试",
  smoke: "实物冒烟"
};

const at = (value: string) => new Date(value).toLocaleString("zh-CN");
const missing = (gaps: AdapterReleaseGate[]) => gaps.map((gate) => gateLabels[gate]).join("、");

/**
 * 适配状态 (design doc §8.4): an adapter stays "开发中" until --check, the simulator tests and a
 * manual bench smoke run are recorded. Smoke records and the release itself are human-only.
 */
export function AdapterRelease({ hardwareId, onError }: { hardwareId: string; onError: ReportError }) {
  const client = useQueryClient();
  const query = useAdapterStatus(hardwareId);
  const [smoke, setSmoke] = useState({ operator: "", wiring: "", observation: "" });
  const mutation = <T,>(run: (input: T) => Promise<AdapterReleaseRecord>, after?: () => void) => ({
    mutationFn: run,
    onMutate: () => onError(null),
    onError: (error: unknown) => onError(errorMessage(error)),
    onSuccess: (record: AdapterReleaseRecord) => {
      client.setQueryData(queryKeys.adapterStatus(hardwareId), record);
      void client.invalidateQueries({ queryKey: queryKeys.deviceCatalog });
      after?.();
    }
  });
  const addSmoke = useMutation(mutation(
    () => window.teststand.devices.recordAdapterSmoke({
      hardwareId, operator: smoke.operator.trim(), wiring: smoke.wiring.trim(), observation: smoke.observation.trim()
    }),
    () => setSmoke({ operator: "", wiring: "", observation: "" })
  ));
  const setStatus = useMutation(mutation(
    (status: AdapterStatus) => window.teststand.devices.setAdapterStatus({ hardwareId, status })
  ));

  const record = query.data;
  if (!record) {
    return (
      <Section title="适配状态">
        <p className="text-xs text-fg-3">{query.isError ? errorMessage(query.error) : "读取中…"}</p>
      </Section>
    );
  }
  const available = record.status === "available";
  const busy = addSmoke.isPending || setStatus.isPending;
  const smokeReady = Boolean(smoke.operator.trim() && smoke.wiring.trim() && smoke.observation.trim());
  const evidence: Record<AdapterReleaseGate, AdapterEvidence | undefined> = {
    check: record.check,
    simulator: record.simulator,
    smoke: record.smoke.at(-1) && { at: record.smoke.at(-1)!.at, note: `${record.smoke.length} 条记录` }
  };
  return (
    <Section
      title="适配状态"
      actions={<Badge tone={available ? "pass" : "neutral"}>{available ? "可用" : "开发中"}</Badge>}
    >
      <ul className="grid gap-1 text-xs" aria-label="发布门槛">
        {(Object.keys(gateLabels) as AdapterReleaseGate[]).map((gate) => {
          const item = evidence[gate];
          return (
            <li key={gate} className="flex items-center gap-2">
              <Badge tone={item ? "pass" : "invalid"}>{item ? "已通过" : "缺"}</Badge>
              <span className="text-fg-2">{gateLabels[gate]}</span>
              {item && (
                <span className="min-w-0 flex-1 truncate text-fg-3" title={item.note}>
                  {at(item.at)}{item.note && ` · ${item.note}`}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {record.smoke.length > 0 && (
        <ul className="grid gap-1 rounded-sm border border-line p-2 text-xs" aria-label="冒烟记录">
          {record.smoke.map((item, index) => (
            <li key={index} className="grid gap-0.5">
              <span className="text-fg-2">{item.operator} · {at(item.at)}</span>
              <span className="break-words text-fg-3">接线：{item.wiring}</span>
              <span className="break-words text-fg-3">观察：{item.observation}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-1.5" role="group" aria-label="添加冒烟记录">
        <Field label="执行人">
          <Input value={smoke.operator} onChange={(event) => setSmoke({ ...smoke, operator: event.target.value })} />
        </Field>
        <Field label="接线">
          <Textarea value={smoke.wiring} onChange={(event) => setSmoke({ ...smoke, wiring: event.target.value })} />
        </Field>
        <Field label="观察结果">
          <Textarea
            value={smoke.observation}
            onChange={(event) => setSmoke({ ...smoke, observation: event.target.value })}
          />
        </Field>
        <div className="flex items-center gap-1.5">
          <Button size="xs" disabled={busy || !smokeReady} onClick={() => addSmoke.mutate(undefined)}>
            添加冒烟记录
          </Button>
          <span className="flex-1" />
          {available ? (
            <Button size="xs" disabled={busy} onClick={() => setStatus.mutate("developing")}>退回开发中</Button>
          ) : (
            <Button
              size="xs"
              variant="primary"
              disabled={busy || record.gaps.length > 0}
              title={record.gaps.length > 0 ? `还缺：${missing(record.gaps)}` : undefined}
              onClick={() => setStatus.mutate("available")}
            >
              标记为可用
            </Button>
          )}
        </div>
      </div>
    </Section>
  );
}
