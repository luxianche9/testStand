import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import type { Hardware, HardwarePort } from "@hardwareharness/contracts/devices";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { errorMessage } from "../../../../lib/errors.js";
import { useDeviceCatalog } from "../../../../lib/queries.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Input } from "../../../../ui";
import { AppearanceImage, PortEditor } from "../../PortEditor.js";
import { BundleActions } from "../BundleActions.js";
import { EditorAlert, EditorField, EditorNote, EditorPanel, editorGrid } from "./EditorField.js";

const hardwareEditorSchema = z.object({
  hardwareId: z.string().trim().min(1, "请输入 hardwareId")
    .refine((value) => !/\s/.test(value), "hardwareId 不能包含空格"),
  label: z.string().trim().min(1, "请输入显示名称")
});
type HardwareEditorValues = z.infer<typeof hardwareEditorSchema>;
const blankHardware: HardwareEditorValues = { hardwareId: "DUT_1", label: "被测对象" };

/** DUTs, fixtures and breakout boards: no MCP Server, just ports and photos. */
export function HardwareEditor({ open, hardware, onClose, onChanged }: {
  open: boolean;
  hardware?: Hardware | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const catalog = useDeviceCatalog();
  const [ports, setPorts] = useState<HardwarePort[]>([]);
  const { register, reset, watch, handleSubmit, formState } = useForm<HardwareEditorValues>({
    resolver: zodResolver(hardwareEditorSchema),
    mode: "onChange",
    defaultValues: blankHardware
  });
  const { errors, isValid } = formState;
  const hardwareId = watch("hardwareId");
  // Image uploads update the catalog; read the stored record so the asset ids stay current.
  const live = hardware
    ? (catalog.data?.hardware.find((item) => item.hardwareId === hardware.hardwareId) ?? hardware)
    : undefined;

  useEffect(() => {
    if (!open) return;
    reset(hardware ? { hardwareId: hardware.hardwareId, label: hardware.label } : blankHardware);
    setPorts(hardware ? structuredClone(hardware.ports) : []);
  }, [hardware, open, reset]);

  const save = useMutation({
    mutationFn: async (values: HardwareEditorValues) => {
      const normalizedId = values.hardwareId.trim();
      return await window.hardwareharness.devices.saveHardware({
        formatVersion: 2,
        hardwareId: normalizedId,
        label: values.label.trim() || normalizedId,
        kind: "passive",
        ports,
        ...(live?.appearanceAssetId ? { appearanceAssetId: live.appearanceAssetId } : {})
      });
    },
    onSuccess: async () => {
      await onChanged();
      onClose();
    }
  });
  const submit = handleSubmit(async (values) => { await save.mutateAsync(values); });
  const syncPorts = (item: Hardware) => setPorts(structuredClone(item.ports));

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent title={hardware ? "编辑硬件" : "添加硬件"} size="lg" className="w-[760px]">
        <DialogBody>
          <form id="hardware-editor-form" className={editorGrid} onSubmit={(event) => { void submit(event); }}>
            <EditorField label="稳定 hardwareId" required error={errors.hardwareId?.message}>
              <Input
                className="font-mono"
                {...register("hardwareId")}
                disabled={Boolean(hardware)}
                placeholder="DUT_1"
              />
            </EditorField>
            <EditorField label="显示名称" required error={errors.label?.message}>
              <Input {...register("label")} />
            </EditorField>
            <EditorNote>被动硬件不由 MCP Server 控制，仅用于接线建模。</EditorNote>
            <EditorPanel>
              <AppearanceImage
                hardwareId={hardwareId}
                assetId={live?.appearanceAssetId}
                saved={Boolean(live)}
                onChanged={syncPorts}
              />
              <PortEditor
                hardwareId={hardwareId}
                ports={ports}
                saved={Boolean(live)}
                onChange={setPorts}
                onImageChanged={syncPorts}
              />
            </EditorPanel>
            {save.isError && <EditorAlert message={errorMessage(save.error)} />}
          </form>
        </DialogBody>
        <DialogFooter>
          <BundleActions
            kind="hardware"
            id={hardwareId}
            saved={Boolean(live)}
            disabled={save.isPending}
            onImported={async () => { await onChanged(); onClose(); }}
          />
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" form="hardware-editor-form" disabled={save.isPending || !isValid}>
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
