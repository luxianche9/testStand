import { useState } from "react";
import type { DashboardSnapshot } from "@teststand/contracts/operations";
import type { Hardware, DeviceInstance } from "@teststand/contracts/devices";
import { MousePointerClickIcon } from "lucide-react";
import { hardwareForDevice } from "../../../lib/hardware.js";
import { useDeviceDefinition } from "../../../lib/queries.js";
import { EmptyState, Section } from "../../../ui";
import { ManualInvokePanel } from "../../manual/index.js";
import { AdapterRelease } from "./AdapterRelease.js";
import { HardwareActions, DeviceActions } from "./DeviceActions.js";
import { DeclaredDevice } from "./DeclaredDevice.js";
import { hardwareRowStatus, modeLabel } from "./device-labels.js";
import { ErrorStrip, HardwareSections, InspectorShell, Meta, Missing } from "./inspector-parts.js";
import { LiveStreams } from "./LiveStreams.js";
import { parseDeviceSelection } from "./selection.js";

type Callbacks = {
  onEditDevice: (instance: DeviceInstance) => void;
  onEditHardware: (hardware: Hardware) => void;
  onChanged: () => Promise<void>;
};

export function DeviceInspector({ selected, snapshot, hardware, ...callbacks }: Callbacks & {
  selected: string | null;
  snapshot: DashboardSnapshot;
  hardware: Hardware[];
}) {
  const selection = parseDeviceSelection(selected);
  if (selection.kind === "device") {
    const instance = snapshot.devices.find((item) => item.deviceId === selection.deviceId);
    if (!instance) return <Missing title="设备不存在" />;
    return (
      <ManagedInspector key={selected} instance={instance} snapshot={snapshot} hardware={hardware} {...callbacks} />
    );
  }
  if (selection.kind === "passive") {
    const item = hardware.find((entry) => entry.hardwareId === selection.hardwareId && entry.kind === "passive");
    if (!item) return <Missing title="硬件不存在" />;
    return <PassiveInspector key={selected} hardware={item} {...callbacks} />;
  }
  return (
    <EmptyState
      icon={<MousePointerClickIcon />}
      title="选择一个设备或硬件"
      description="左侧列表只显示状态。点选后，详情、操作和 MCP 工具会出现在这里。"
    />
  );
}

function ManagedInspector({ instance, snapshot, hardware, onEditDevice, onChanged }:
  Callbacks & { instance: DeviceInstance; snapshot: DashboardSnapshot; hardware: Hardware[] }) {
  const [error, setError] = useState<string | null>(null);
  const device = hardwareForDevice(instance, hardware);
  const deviceStatus = snapshot.deviceStatuses.find((item) => item.deviceId === instance.deviceId);
  const availability = snapshot.availability?.find((item) => item.hardwareId === instance.hardwareId);
  const status = hardwareRowStatus(deviceStatus, availability);
  const online = deviceStatus?.transport.state === "online";
  // The device's own declaration wins; the catalog record is the fallback.
  const definition = useDeviceDefinition(instance.hardwareId).data;
  return (
    <InspectorShell
      title={device?.label ?? instance.label}
      status={status}
      actions={
        <DeviceActions
          instance={instance}
          onEdit={() => onEditDevice(instance)}
          onChanged={onChanged}
          onError={setError}
        />
      }
      notice={error && <ErrorStrip message={error} />}
    >
      <Section title="基本信息">
        <Meta items={[
          { label: "硬件 ID", value: instance.hardwareId },
          { label: "Device ID", value: instance.deviceId },
          { label: "设备类型", value: instance.type },
          { label: "运行模式", value: modeLabel(instance.mode) }
        ]} />
        {status.title && <p className="text-xs break-words text-fg-3">{status.title}</p>}
      </Section>
      <AdapterRelease hardwareId={instance.hardwareId} onError={setError} />
      <LiveStreams hardwareId={instance.hardwareId} running={online} />
      <ManualInvokePanel hardwareId={instance.hardwareId} />
      {definition ? <DeclaredDevice definition={definition} /> : device && <HardwareSections hardware={device} />}
    </InspectorShell>
  );
}

function PassiveInspector({ hardware, onEditHardware, onChanged }: Callbacks & { hardware: Hardware }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <InspectorShell
      title={hardware.label}
      actions={<HardwareActions hardware={hardware} onEdit={onEditHardware} onChanged={onChanged} onError={setError} />}
      notice={error && <ErrorStrip message={error} />}
    >
      <Section title="基本信息">
        <Meta items={[
          { label: "硬件 ID", value: hardware.hardwareId }
        ]} />
      </Section>
      <HardwareSections hardware={hardware} />
    </InspectorShell>
  );
}
