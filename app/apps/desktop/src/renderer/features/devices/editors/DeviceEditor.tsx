import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { DeviceInstance, DeviceType } from "@teststand/contracts/devices";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { errorMessage } from "../../../lib/errors.js";
import { useDashboard } from "../../../lib/queries.js";
import { queryKeys } from "../../../lib/query-keys.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Input, Select, Textarea } from "../../../ui";
import { EditorAlert, EditorField, EditorNote, editorGrid } from "./EditorField.js";

/** `settings` is edited as JSON text; only a JSON object is accepted. */
function parseSettings(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text.trim() || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

const deviceEditorSchema = z.object({
  type: z.string().trim().min(1, "请选择设备类型"),
  label: z.string(),
  mode: z.enum(["real", "sim"]),
  settings: z.string().refine((value) => parseSettings(value) !== undefined, "设置必须是 JSON 对象")
});
type DeviceEditorValues = z.infer<typeof deviceEditorSchema>;

function initialValues(instance: DeviceInstance | undefined): DeviceEditorValues {
  if (!instance) return { type: "", label: "", mode: "real", settings: "{}" };
  return {
    type: instance.type,
    label: instance.label,
    mode: instance.mode,
    settings: JSON.stringify(instance.settings, null, 2)
  };
}

function typeLabel(item: DeviceType): string {
  const name = [item.manufacturer, item.model].filter(Boolean).join(" ") || item.type;
  return item.error ? `${name}（不可用：${item.error}）` : name;
}

/** The first free `PCI1762`, `PCI1762_2`, … for a new device of `type`. */
function nextDeviceId(type: string, taken: Set<string>): string {
  const base = type.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

/** Add or edit a device: an installed type, a name and real/sim. Its ids are generated and its
 *  connectors come from the plugin, so there is nothing else to fill in. */
export function DeviceEditor({ open, instance, onClose, onChanged }: {
  open: boolean;
  instance?: DeviceInstance | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const dashboard = useDashboard();
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
  const selectedType = types.data?.find((item) => item.type === watch("type"));

  useEffect(() => {
    if (open) reset(initialValues(instance));
  }, [open, instance, reset]);

  // Picking a type names the device after its model unless the user typed a name.
  const typeField = register("type", {
    onChange: (event: { target: { value: string } }) => {
      const picked = types.data?.find((item) => item.type === event.target.value);
      if (picked?.model && !getValues("label")) setValue("label", picked.model);
    }
  });

  const save = useMutation({
    mutationFn: async (values: DeviceEditorValues) => {
      const devices = window.teststand.devices;
      const deviceId = instance?.deviceId
        ?? nextDeviceId(values.type, new Set((dashboard.data?.devices ?? []).map((item) => item.deviceId)));
      const input: DeviceInstance = {
        deviceId,
        label: values.label.trim() || selectedType?.model || deviceId,
        hardwareId: instance?.hardwareId ?? `${deviceId}_CARD`,
        type: values.type,
        settings: parseSettings(values.settings) ?? {},
        mode: values.mode,
        enabled: instance?.enabled ?? true
      };
      const saved = await devices.saveDevice({ input });
      // Connecting loads the plugin and gives the device its declared connectors.
      await devices.refreshDevice({ deviceId });
      return saved;
    },
    onSuccess: async () => { await onChanged(); onClose(); }
  });
  const submit = handleSubmit(async (values) => { await save.mutateAsync(values); });

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent title={instance ? "编辑设备" : "添加设备"} size="md">
        <DialogBody>
          <form id="device-editor-form" className={editorGrid} onSubmit={(event) => { void submit(event); }}>
            <EditorField
              label="设备类型"
              required
              span
              error={errors.type?.message ?? (types.isError ? errorMessage(types.error) : undefined)}
            >
              {instance ? (
                <Input value={selectedType ? typeLabel(selectedType) : instance.type} disabled />
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
              <EditorNote>还没有安装任何设备类型：点设备列表上方的「设备类型」，安装对应的 .tsdev 设备包。</EditorNote>
            )}
            <EditorField label="名称">
              <Input {...register("label")} placeholder={selectedType?.model ?? "继电器卡"} />
            </EditorField>
            <EditorField label="运行模式">
              <Select {...register("mode")}>
                <option value="real">实物（驱动真实板卡）</option>
                <option value="sim">模拟（不接硬件）</option>
              </Select>
            </EditorField>
            <details className="col-span-2 text-xs text-fg-2">
              <summary className="cursor-pointer select-none py-1">高级设置</summary>
              <EditorField label="插件设置（JSON）" span error={errors.settings?.message}>
                <Textarea className="min-h-[72px] font-mono text-xs" spellCheck={false} {...register("settings")} />
              </EditorField>
            </details>
            {save.isError && <EditorAlert message={errorMessage(save.error)} />}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" form="device-editor-form" disabled={save.isPending || !isValid}>
            {save.isPending ? "正在连接…" : instance ? "保存" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
