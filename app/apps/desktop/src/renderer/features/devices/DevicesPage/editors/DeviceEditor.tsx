import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  DeviceBundlePreview, DeviceType, Hardware, HardwarePort, DeviceInstance
} from "@teststand/contracts/devices";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { errorMessage } from "../../../../lib/errors.js";
import { hardwareForDevice } from "../../../../lib/hardware.js";
import { queryKeys } from "../../../../lib/query-keys.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Input, Select, Textarea } from "../../../../ui";
import { PortEditor } from "../../PortEditor.js";
import { BundleActions } from "../BundleActions.js";
import { EditorAlert, EditorField, EditorNote, EditorPanel, editorGrid } from "./EditorField.js";

/** `settings` is edited as JSON text; only a JSON object is accepted. */
function parseSettings(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text.trim() || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

const required = (message: string) => z.string().trim().min(1, message);
const deviceEditorSchema = z.object({
  type: required("请选择设备类型"),
  deviceId: required("请输入 Device ID"),
  label: z.string(),
  hardwareId: required("请输入 Hardware ID"),
  mode: z.enum(["real", "sim"]),
  settings: z.string().refine((value) => parseSettings(value) !== undefined, "settings 必须是 JSON 对象")
});
type DeviceEditorValues = z.infer<typeof deviceEditorSchema>;

function initialValues(instance: DeviceInstance | undefined): DeviceEditorValues {
  if (!instance) return { type: "", deviceId: "", label: "", hardwareId: "", mode: "real", settings: "{}" };
  return {
    type: instance.type,
    deviceId: instance.deviceId,
    label: instance.label,
    hardwareId: instance.hardwareId,
    mode: instance.mode,
    settings: JSON.stringify(instance.settings, null, 2)
  };
}

function typeLabel(item: DeviceType): string {
  const name = [item.manufacturer, item.model].filter(Boolean).join(" ") || item.type;
  return item.error ? `${name}（${item.type}，不可用：${item.error}）` : `${name}（${item.type}）`;
}

/** A device plugin instance and the managed hardware it drives are edited together. */
export function DeviceEditor({ open, instance, hardware, onClose, onChanged }: {
  open: boolean;
  instance?: DeviceInstance | undefined;
  hardware: Hardware[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const types = useQuery({
    queryKey: queryKeys.deviceTypes,
    queryFn: () => window.teststand.devices.listDeviceTypes(),
    enabled: open
  });
  const { register, reset, watch, getValues, setValue, handleSubmit, formState } = useForm<DeviceEditorValues>({
    resolver: zodResolver(deviceEditorSchema),
    mode: "onChange",
    defaultValues: initialValues(undefined)
  });
  const { errors, isValid } = formState;
  const [ports, setPorts] = useState<HardwarePort[]>([]);
  const [bundlePreview, setBundlePreview] = useState<DeviceBundlePreview>();
  // Bumped to clear the bundle notice when the hardware binding changes by hand.
  const [bundleKey, setBundleKey] = useState(0);
  const hardwareId = watch("hardwareId");
  const selectedType = types.data?.find((item) => item.type === watch("type"));
  const live = instance ? hardwareForDevice(instance, hardware) : undefined;
  const selectedHardware = live ?? hardware.find((item) => item.hardwareId === hardwareId);

  useEffect(() => {
    if (!open) return;
    reset(initialValues(instance));
    setPorts(live ? structuredClone(live.ports) : []);
    setBundlePreview(undefined);
    setBundleKey((key) => key + 1);
    // Catalog refetches refresh `live`; they must not discard ports the user is midway through typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, instance?.deviceId]);

  // Picking a type fills the ids and name the user has not typed yet.
  const typeField = register("type", {
    onChange: (event: { target: { value: string } }) => {
      const picked = types.data?.find((item) => item.type === event.target.value);
      if (!picked) return;
      const id = picked.type.toUpperCase();
      if (!getValues("deviceId")) setValue("deviceId", id, { shouldValidate: true });
      if (!getValues("hardwareId")) setValue("hardwareId", `${id}_CARD_0`, { shouldValidate: true });
      if (!getValues("label") && picked.model) setValue("label", picked.model);
    }
  });
  const hardwareIdField = register("hardwareId", {
    onChange: (event: { target: { value: string } }) => {
      const known = hardware.find((item) => item.hardwareId === event.target.value);
      setBundlePreview(undefined);
      setBundleKey((key) => key + 1);
      if (known) setPorts(structuredClone(known.ports));
    }
  });

  const stagePreview = (preview: DeviceBundlePreview) => {
    if (instance && preview.hardware.hardwareId !== instance.hardwareId) {
      throw new Error(`当前设备绑定的是 ${instance.hardwareId}，不能导入 ${preview.hardware.hardwareId}`);
    }
    setBundlePreview(preview);
    setValue("hardwareId", preview.hardware.hardwareId, { shouldValidate: true });
    setValue("label", preview.hardware.label, { shouldValidate: true });
    setPorts(structuredClone(preview.hardware.ports));
    return `已载入 ${preview.hardware.label}；保存设备后才会写入并绑定`;
  };

  const save = useMutation({
    mutationFn: async (values: DeviceEditorValues) => {
      const devices = window.teststand.devices;
      const deviceId = values.deviceId.trim();
      const boundId = values.hardwareId.trim();
      const input: DeviceInstance = {
        deviceId,
        label: values.label.trim() || deviceId,
        hardwareId: boundId,
        type: values.type,
        settings: parseSettings(values.settings) ?? {},
        mode: values.mode,
        enabled: instance?.enabled ?? true
      };
      const saved = await devices.saveDevice({ input });
      if (bundlePreview) {
        await devices.importBundleForDevice({ data: bundlePreview.data, hardwareId: boundId, deviceId });
      }
      await devices.saveHardware({
        input: { formatVersion: 2, hardwareId: boundId, label: input.label, kind: "managed", deviceId, ports }
      });
      await devices.refreshDevice({ deviceId });
      return saved;
    },
    onSuccess: async () => { await onChanged(); onClose(); }
  });
  const submit = handleSubmit(async (values) => { await save.mutateAsync(values); });
  const bindable = hardware.filter((item) => item.kind === "passive" || item.deviceId === instance?.deviceId);

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent title={instance ? "编辑测试资源" : "添加测试资源"} size="lg" className="w-[760px]">
        <DialogBody>
          <form id="device-editor-form" className={editorGrid} onSubmit={(event) => { void submit(event); }}>
            <EditorField
              label="设备类型"
              required
              span
              error={errors.type?.message ?? (types.isError ? errorMessage(types.error) : undefined)}
            >
              {instance ? (
                <Input className="font-mono" value={selectedType ? typeLabel(selectedType) : instance.type} disabled />
              ) : (
                <Select {...typeField}>
                  <option value="">{types.isPending ? "正在读取已安装的设备类型…" : "选择设备类型"}</option>
                  {types.data?.map((item) => (
                    <option key={item.type} value={item.type} disabled={Boolean(item.error)}>{typeLabel(item)}</option>
                  ))}
                </Select>
              )}
            </EditorField>
            {selectedType?.description && <EditorNote>{selectedType.description}</EditorNote>}
            {!instance && types.data?.length === 0 && (
              <EditorNote>还没有安装任何设备类型：在设备管理页点“设备类型”，安装对应的 .tsdev 设备包。</EditorNote>
            )}
            <EditorField label="Device ID" required error={errors.deviceId?.message}>
              <Input
                className="font-mono"
                {...register("deviceId")}
                disabled={Boolean(instance)}
                placeholder="PCI1762"
              />
            </EditorField>
            <EditorField label="显示名称">
              <Input {...register("label")} placeholder="PCI-1762 继电器卡" />
            </EditorField>
            <EditorField label="唯一 Hardware ID" required error={errors.hardwareId?.message}>
              <Input
                className="font-mono"
                list="teststand-hardware-ids"
                {...hardwareIdField}
                disabled={Boolean(instance)}
                placeholder="PCI1762_CARD_0"
              />
            </EditorField>
            <datalist id="teststand-hardware-ids">
              {bindable.map((item) => <option key={item.hardwareId} value={item.hardwareId}>{item.label}</option>)}
            </datalist>
            <EditorField label="运行模式">
              <Select {...register("mode")}>
                <option value="real">实物（驱动真实板卡）</option>
                <option value="sim">模拟（使用插件自带的模拟器）</option>
              </Select>
            </EditorField>
            <EditorField label="settings（JSON）" span error={errors.settings?.message}>
              <Textarea className="min-h-[72px] font-mono text-xs" spellCheck={false} {...register("settings")} />
            </EditorField>
            <EditorNote>
              可直接在这里导入 `.tshw`；testStand 会在保存设备时绑定硬件。端口和针脚用于接线画布。
            </EditorNote>
            <EditorPanel>
              <PortEditor ports={ports} onChange={setPorts} />
            </EditorPanel>
            {save.isError && <EditorAlert message={errorMessage(save.error)} />}
          </form>
        </DialogBody>
        <DialogFooter>
          <BundleActions
            key={bundleKey}
            kind="hardware"
            id={hardwareId}
            saved={Boolean(selectedHardware)}
            disabled={save.isPending}
            exportTitle="导出这台设备的硬件定义"
            onPreview={stagePreview}
          />
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" form="device-editor-form" disabled={save.isPending || !isValid}>
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
