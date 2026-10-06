import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import type { DeviceInstance } from "@teststand/contracts/devices";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { errorMessage } from "../../../lib/errors.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Input, Textarea } from "../../../ui";
import { EditorAlert, EditorField, editorGrid } from "./EditorField.js";

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
  label: z.string(),
  settings: z.string().refine((value) => parseSettings(value) !== undefined, "设置必须是 JSON 对象")
});
type DeviceEditorValues = z.infer<typeof deviceEditorSchema>;

function initialValues(instance: DeviceInstance): DeviceEditorValues {
  return { label: instance.label, settings: JSON.stringify(instance.settings, null, 2) };
}

/** Edit a device: its name and (advanced) the driver's own settings. Adding a
 *  device is done from its device package (AddDeviceDialog). */
export function DeviceEditor({ instance, onClose, onChanged }: {
  instance: DeviceInstance | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const open = Boolean(instance);
  const { register, reset, handleSubmit, formState } = useForm<DeviceEditorValues>({
    resolver: zodResolver(deviceEditorSchema),
    mode: "onChange",
    defaultValues: { label: "", settings: "{}" }
  });
  const { errors, isValid } = formState;

  useEffect(() => {
    if (instance) reset(initialValues(instance));
  }, [instance, reset]);

  const save = useMutation({
    mutationFn: async (values: DeviceEditorValues) => {
      if (!instance) return;
      const devices = window.teststand.devices;
      await devices.saveDevice({ input: {
        ...instance,
        label: values.label.trim() || instance.label,
        settings: parseSettings(values.settings) ?? {}
      } });
      await devices.refreshDevice({ deviceId: instance.deviceId });
    },
    onSuccess: async () => { await onChanged(); onClose(); }
  });
  const submit = handleSubmit(async (values) => { await save.mutateAsync(values); });

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent title="编辑设备" size="md">
        <DialogBody>
          <form id="device-editor-form" className={editorGrid} onSubmit={(event) => { void submit(event); }}>
            <EditorField label="名称">
              <Input {...register("label")} />
            </EditorField>
            <details className="col-span-2 text-xs text-fg-2">
              <summary className="cursor-pointer select-none py-1">高级设置</summary>
              <EditorField label="驱动设置（JSON）" span error={errors.settings?.message}>
                <Textarea className="min-h-[72px] font-mono text-xs" spellCheck={false} {...register("settings")} />
              </EditorField>
            </details>
            {save.isError && <EditorAlert message={errorMessage(save.error)} />}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" form="device-editor-form" disabled={save.isPending || !isValid}>
            {save.isPending ? "正在连接…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
