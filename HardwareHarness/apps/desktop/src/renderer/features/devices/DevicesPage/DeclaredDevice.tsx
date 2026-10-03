import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  DeviceDeclaredConnector, DeviceDeclaredPin, DeviceLeaseStatus, ManagedDeviceDefinition
} from "@hardwareharness/contracts/devices";
import { errorMessage } from "../../../lib/errors.js";
import { useDeviceLease } from "../../../lib/queries.js";
import { queryKeys } from "../../../lib/query-keys.js";
import { Badge, Button, Section, useConfirm } from "../../../ui";
import type { ReportError } from "./DeviceActions.js";
import { Meta } from "./inspector-parts.js";

/**
 * What a managed device says about itself (`/device`, design doc §9.7): identity and pinout
 * come from the service and are read-only here. Offline, the cached copy is shown and
 * labelled as such.
 */
export function DeclaredDevice({ definition }: { definition: ManagedDeviceDefinition }) {
  const { document } = definition;
  const identity = document.identity;
  const connectors = document.pinout?.connectors ?? [];
  const pins = new Map((document.pinout?.pins ?? []).map((pin) => [pin.pinId, pin]));
  const adapter = identity.adapter ? `${identity.adapter.name} ${identity.adapter.version}` : undefined;
  return (
    <>
      <Section
        title="设备声明"
        actions={
          <span className="flex items-center gap-1">
            {identity.dryRun && <Badge tone="signal">模拟运行</Badge>}
            {definition.offline && <Badge tone="invalid">离线，显示的是缓存版本</Badge>}
          </span>
        }
      >
        {document.description && <p className="text-xs break-words text-fg-2">{document.description}</p>}
        <Meta items={[
          ...(identity.manufacturer ? [{ label: "厂商", value: identity.manufacturer }] : []),
          ...(identity.model ? [{ label: "型号", value: identity.model }] : []),
          ...(identity.hardwareRevision ? [{ label: "硬件版本", value: identity.hardwareRevision }] : []),
          ...(adapter ? [{ label: "适配器", value: adapter }] : []),
          ...(identity.sdkVersion ? [{ label: "SDK", value: identity.sdkVersion }] : []),
          {
            label: "声明版本",
            value: <span title={definition.manifestRevision}>{shortRevision(definition.manifestRevision)}</span>
          },
          { label: "获取时间", value: definition.fetchedAt }
        ]} />
      </Section>
      <Section
        title="端口"
        actions={<span className="tf-num text-2xs text-fg-3">{connectors.length} 端口 · {pins.size} 针 · 由服务声明</span>}
      >
        {connectors.length === 0 && <p className="text-xs text-fg-3">服务没有声明端口。</p>}
        {connectors.map((connector) => (
          <DeclaredConnector
            key={connector.connectorId}
            connector={connector}
            pins={connector.pinIds.flatMap((pinId) => pins.get(pinId) ?? [])}
          />
        ))}
      </Section>
    </>
  );
}

function DeclaredConnector({ connector, pins }: {
  connector: DeviceDeclaredConnector;
  pins: DeviceDeclaredPin[];
}) {
  return (
    <article className="rounded-md border border-line" aria-label={`端口 ${connector.name}`}>
      <header className="flex h-7 items-center gap-2 border-b border-line bg-surface-2/50 px-2">
        <strong className="text-xs font-medium text-fg">{connector.name}</strong>
        <span className="tf-num text-2xs text-fg-3">{connector.connectorType}</span>
        <Badge className="ml-auto" mono>{pins.length ? `${pins.length} 针` : "无针脚"}</Badge>
      </header>
      {pins.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-left text-2xs text-fg-3">
            <tr>
              <th className="px-2 py-1 font-normal">针脚</th>
              <th className="px-2 py-1 font-normal">位置</th>
              <th className="px-2 py-1 font-normal">功能</th>
            </tr>
          </thead>
          <tbody>
            {pins.map((pin) => (
              <tr key={pin.pinId} className="border-t border-line">
                <td className="tf-num px-2 py-0.5 text-fg">{pin.pinId}</td>
                <td className="tf-num px-2 py-0.5 text-fg-2">{pin.position}</td>
                <td className="px-2 py-0.5 text-fg-2">
                  {pin.functions.map((fn) => fn.signal).join(" / ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}

/** Lease holder and the release / force-release actions (§4.5). */
export function LeaseControls({ hardwareId, online, onError }: {
  hardwareId: string;
  online: boolean;
  onError: ReportError;
}) {
  const client = useQueryClient();
  const lease = useDeviceLease(hardwareId, online);
  const [confirm, confirmNode] = useConfirm();
  const settled = () => void client.invalidateQueries({ queryKey: queryKeys.deviceLease(hardwareId) });
  const release = useMutation({
    mutationFn: () => window.hardwareharness.streams.leaseRelease(hardwareId),
    onMutate: () => onError(null),
    onError: (error) => onError(errorMessage(error)),
    onSettled: settled
  });
  const forceRelease = useMutation({
    mutationFn: () => window.hardwareharness.streams.leaseForceRelease(hardwareId, "forced from the device page"),
    onMutate: () => onError(null),
    onError: (error) => onError(errorMessage(error)),
    onSettled: settled
  });
  const requestForceRelease = async (status: DeviceLeaseStatus) => {
    const holder = holderLabel(status);
    const first = await confirm({
      title: "强制释放租约",
      message: `设备正被 ${holder} 占用。强制释放会中断对方正在进行的操作，服务会把设备驱动到安全状态。`,
      confirmLabel: "继续",
      danger: true
    });
    if (!first) return;
    const second = await confirm({
      title: "再次确认强制释放",
      message: `确定要从 ${holder} 手中收回这台设备吗？此操作无法撤销。`,
      confirmLabel: "强制释放",
      danger: true
    });
    if (second) forceRelease.mutate();
  };

  const status = lease.data;
  const busy = release.isPending || forceRelease.isPending;
  return (
    <Section title="租约">
      {!online && <p className="text-xs text-fg-3">服务不可达，无法查询租约。</p>}
      {online && !status && <p className="text-xs text-fg-3">{lease.isError ? errorMessage(lease.error) : "查询中…"}</p>}
      {online && status && (
        <div className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-fg-2">
            {!status.held ? "空闲" : status.heldByThisTerminal ? "本终端持有" : `被 ${holderLabel(status)} 持有`}
          </span>
          {status.held && status.heldByThisTerminal && (
            <Button size="xs" disabled={busy} onClick={() => release.mutate()}>释放</Button>
          )}
          {status.held && !status.heldByThisTerminal && (
            <Button size="xs" variant="danger" disabled={busy} onClick={() => void requestForceRelease(status)}>
              强制释放
            </Button>
          )}
        </div>
      )}
      {confirmNode}
    </Section>
  );
}

function holderLabel(status: DeviceLeaseStatus): string {
  const holder = status.holder;
  if (!holder) return "其他终端";
  if (holder.user && holder.host) return `${holder.user}@${holder.host}`;
  return holder.label ?? holder.user ?? holder.host ?? holder.terminalId;
}

function shortRevision(revision: string): string {
  const [, digest = revision] = revision.split(":");
  return digest.slice(0, 12);
}
