import { useMutation } from "@tanstack/react-query";
import type { Hardware, DeviceInstance } from "@teststand/contracts/devices";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { errorMessage } from "../../../lib/errors.js";
import { Button, IconButton, useConfirm } from "../../../ui";

/** Reported by every action group so the inspector shows one error strip under its header. */
export type ReportError = (message: string | null) => void;

/** Header actions of a managed device. */
export function DeviceActions({ instance, onEdit, onChanged, onError }: {
  instance: DeviceInstance;
  onEdit: () => void;
  onChanged: () => Promise<void>;
  onError: ReportError;
}) {
  const [confirm, confirmNode] = useConfirm();
  const remove = useMutation({
    mutationFn: () => window.teststand.devices.removeDevice({ deviceId: instance.deviceId }),
    onMutate: () => onError(null),
    onError: (error) => onError(errorMessage(error)),
    onSettled: () => void onChanged()
  });
  const requestRemove = async () => {
    const ok = await confirm({
      title: "删除设备",
      message: `删除 ${instance.label}（${instance.deviceId}）？端口和接线定义保留为被动硬件。`,
      confirmLabel: "删除",
      danger: true
    });
    if (ok) remove.mutate();
  };
  return (
    <>
      <IconButton label="编辑信息" size="icon-sm" onClick={onEdit}><PencilIcon /></IconButton>
      <IconButton label="删除设备" size="icon-sm" disabled={remove.isPending} onClick={() => void requestRemove()}>
        <Trash2Icon />
      </IconButton>
      {confirmNode}
    </>
  );
}

export function HardwareActions({ hardware, onEdit, onChanged, onError }: {
  hardware: Hardware;
  onEdit: (hardware: Hardware) => void;
  onChanged: () => Promise<void>;
  onError: ReportError;
}) {
  const [confirm, confirmNode] = useConfirm();
  const remove = useMutation({
    mutationFn: () => window.teststand.devices.removeHardware({ hardwareId: hardware.hardwareId }),
    onMutate: () => onError(null),
    onError: (error) => onError(errorMessage(error)),
    onSettled: () => void onChanged()
  });
  const requestRemove = async () => {
    const ok = await confirm({
      title: "移除硬件",
      message: `移除 ${hardware.label}？端口和针脚会一并删除，画布上引用它的节点会显示为未解析。`,
      confirmLabel: "移除",
      danger: true
    });
    if (ok) remove.mutate();
  };
  return (
    <>
      <Button size="xs" aria-label="编辑" onClick={() => onEdit(hardware)}><PencilIcon />编辑</Button>
      <IconButton label="移除硬件" size="icon-sm" disabled={remove.isPending} onClick={() => void requestRemove()}>
        <Trash2Icon />
      </IconButton>
      {confirmNode}
    </>
  );
}
