import type {
  DeviceDeclaredConnector, DeviceDeclaredPin, ManagedDeviceDefinition
} from "@hardwareharness/contracts/devices";
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

function shortRevision(revision: string): string {
  const [, digest = revision] = revision.split(":");
  return digest.slice(0, 12);
}
