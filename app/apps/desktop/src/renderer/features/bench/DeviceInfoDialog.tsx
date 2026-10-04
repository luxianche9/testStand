import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { DeviceInstance, Hardware } from "@teststand/contracts/devices";
import { PencilIcon, RefreshCwIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { useDashboard, useDeviceDefinition } from "../../lib/queries.js";
import { Badge, Button, Dialog, DialogBody, DialogContent, DialogFooter, Section, cn, useConfirm } from "../../ui";
import { hardwareRowStatus, modeLabel } from "../devices/device-labels.js";
import { ErrorStrip, HardwareSections, Meta } from "../devices/inspector-parts.js";
import { LiveStreams } from "../devices/LiveStreams.js";

/** Who the dialog is about: a device (plugin instance) or a passive part (DUT, fixture). */
export type InfoTarget = { hardware: Hardware; instance?: DeviceInstance | undefined };

/** 设备信息: opened by clicking a device in the list. Identity, status, connector pins and live
 *  data, plus edit / delete. Placing it on the canvas is done by dragging the list row. */
export function DeviceInfoDialog({ target, onClose, onEdit, onChanged }: {
  target: InfoTarget | undefined;
  onClose: () => void;
  onEdit: (target: InfoTarget) => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => { if (!open) onClose(); }}>
      {target && (
        <DialogContent title={target.hardware.label} size="lg">
          {target.instance
            ? <DeviceInfo key={target.instance.deviceId} target={target} instance={target.instance} onClose={onClose}
                onEdit={onEdit} onChanged={onChanged} />
            : <PartInfo key={target.hardware.hardwareId} target={target} onClose={onClose} onEdit={onEdit}
                onChanged={onChanged} />}
        </DialogContent>
      )}
    </Dialog>
  );
}

type InfoProps = {
  target: InfoTarget;
  onClose: () => void;
  onEdit: (target: InfoTarget) => void;
  onChanged: () => Promise<void>;
};

function DeviceInfo({ target, instance, onClose, onEdit, onChanged }: InfoProps & { instance: DeviceInstance }) {
  const dashboard = useDashboard();
  const definition = useDeviceDefinition(instance.hardwareId).data;
  const [confirm, confirmNode] = useConfirm();
  const [error, setError] = useState<string>();
  const deviceStatus = dashboard.data?.deviceStatuses.find((item) => item.deviceId === instance.deviceId);
  const availability = dashboard.data?.availability?.find((item) => item.hardwareId === instance.hardwareId);
  const status = hardwareRowStatus(deviceStatus, availability);
  const identity = definition?.document.identity;
  const refresh = useMutation({
    mutationFn: () => window.teststand.devices.refreshDevice({ deviceId: instance.deviceId }),
    onMutate: () => setError(undefined),
    onError: (reason) => setError(errorMessage(reason)),
    onSettled: () => void onChanged()
  });
  const remove = useMutation({
    mutationFn: () => window.teststand.devices.removeDevice({ deviceId: instance.deviceId }),
    onError: (reason) => setError(errorMessage(reason)),
    onSuccess: async () => { await onChanged(); onClose(); }
  });
  const requestRemove = async () => {
    if (await confirm({
      title: "删除设备",
      message: `删除 ${instance.label}？画布上的卡片和接线保留，设备不再受控。`,
      confirmLabel: "删除",
      danger: true
    })) remove.mutate();
  };
  return (
    <>
      {error && <ErrorStrip message={error} />}
      <DialogBody className="grid gap-1 p-0">
        <Section
          title="基本信息"
          actions={
            <span className="flex items-center gap-1">
              {instance.mode === "sim" && <Badge tone="signal">模拟</Badge>}
              <Badge tone={status.tone} title={status.title}>{status.label}</Badge>
            </span>
          }
        >
          {definition?.document.description && (
            <p className="text-xs break-words text-fg-2">{definition.document.description}</p>
          )}
          <Meta items={[
            {
              label: "型号",
              value: identity ? `${identity.manufacturer ?? ""} ${identity.model ?? ""}`.trim() : instance.type
            },
            { label: "设备类型", value: instance.type },
            { label: "运行模式", value: modeLabel(instance.mode) },
            { label: "设备 ID", value: instance.deviceId }
          ]} />
          {status.title && <p className={cn("text-xs break-words", status.tone === "fail" ? "text-fail" : "text-fg-3")}>
            {status.title}
          </p>}
        </Section>
        <HardwareSections hardware={target.hardware} />
        <LiveStreams hardwareId={instance.hardwareId} running={deviceStatus?.transport.state === "online"} />
      </DialogBody>
      <DialogFooter>
        <Button className="mr-auto" variant="danger" disabled={remove.isPending} onClick={() => void requestRemove()}>
          <Trash2Icon />删除
        </Button>
        <Button disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          <RefreshCwIcon className={cn(refresh.isPending && "animate-spin")} />检测状态
        </Button>
        <Button variant="primary" onClick={() => onEdit(target)}><PencilIcon />编辑</Button>
      </DialogFooter>
      {confirmNode}
    </>
  );
}

function PartInfo({ target, onClose, onEdit, onChanged }: InfoProps) {
  const { hardware } = target;
  const [confirm, confirmNode] = useConfirm();
  const [error, setError] = useState<string>();
  const remove = useMutation({
    mutationFn: () => window.teststand.devices.removeHardware({ hardwareId: hardware.hardwareId }),
    onError: (reason) => setError(errorMessage(reason)),
    onSuccess: async () => { await onChanged(); onClose(); }
  });
  const exportBundle = useMutation({
    mutationFn: async () => window.teststand.dialogs.saveBundle(
      "hardware", hardware.hardwareId, await window.teststand.devices.exportBundle({ hardwareId: hardware.hardwareId })
    ),
    onError: (reason) => setError(errorMessage(reason))
  });
  const requestRemove = async () => {
    if (await confirm({
      title: "删除被测件",
      message: `删除 ${hardware.label}？它的端口和针脚一并删除，画布上的卡片会显示为未解析。`,
      confirmLabel: "删除",
      danger: true
    })) remove.mutate();
  };
  return (
    <>
      {error && <ErrorStrip message={error} />}
      <DialogBody className="grid gap-1 p-0">
        <Section title="基本信息" actions={<Badge>被测件 / 夹具</Badge>}>
          <Meta items={[{ label: "硬件 ID", value: hardware.hardwareId }]} />
        </Section>
        <HardwareSections hardware={hardware} />
      </DialogBody>
      <DialogFooter>
        <Button className="mr-auto" variant="danger" disabled={remove.isPending} onClick={() => void requestRemove()}>
          <Trash2Icon />删除
        </Button>
        <Button disabled={exportBundle.isPending} title="导出为 .tshw 文件" onClick={() => exportBundle.mutate()}>
          <UploadIcon />导出
        </Button>
        <Button variant="primary" onClick={() => onEdit(target)}><PencilIcon />编辑</Button>
      </DialogFooter>
      {confirmNode}
    </>
  );
}
