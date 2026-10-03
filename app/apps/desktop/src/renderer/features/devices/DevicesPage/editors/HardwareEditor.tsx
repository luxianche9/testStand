import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import type { Hardware, HardwarePort } from "@teststand/contracts/devices";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { errorMessage } from "../../../../lib/errors.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Input } from "../../../../ui";
import { PortEditor } from "../../PortEditor.js";
import { BundleActions } from "../BundleActions.js";
import { EditorAlert, EditorField, EditorNote, EditorPanel, editorGrid } from "./EditorField.js";

const hardwareEditorSchema = z.object({
  hardwareId: z.string().trim().min(1, "请输入 hardwareId")
    .refine((value) => !/\s/.test(value), "hardwareId 不能包含空格"),
  label: z.string().trim().min(1, "请输入显示名称")
});
type HardwareEditorValues = z.infer<typeof hardwareEditorSchema>;
const blankHardware: HardwareEditorValues = { hardwareId: "DUT_1", label: "被测对象" };

/** DUTs, fixtures and breakout boards: no device plugin, just ports. */
export function HardwareEditor({ open, hardware, onClose, onChanged }: {
  open: boolean;
  hardware?: Hardware | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [ports, setPorts] = useState<HardwarePort[]>([]);
  const { register, reset, watch, handleSubmit, formState } = useForm<HardwareEditorValues>({
    resolver: zodResolver(hardwareEditorSchema),
    mode: "onChange",
    defaultValues: blankHardware
  });
  const { errors, isValid } = formState;
  const hardwareId = watch("hardwareId");

  useEffect(() => {
    if (!open) return;
    reset(hardware ? { hardwareId: hardware.hardwareId, label: hardware.label } : blankHardware);
    setPorts(hardware ? structuredClone(hardware.ports) : []);
  }, [hardware, open, reset]);

  const save = useMutation({
    mutationFn: async (values: HardwareEditorValues) => {
      const normalizedId = values.hardwareId.trim();
      return await window.teststand.devices.saveHardware({
        input: {
          formatVersion: 2,
          hardwareId: normalizedId,
          label: values.label.trim() || normalizedId,
          kind: "passive",
          ports
        }
      });
    },
    onSuccess: async () => {
      await onChanged();
      onClose();
    }
  });
  const submit = handleSubmit(async (values) => { await save.mutateAsync(values); });

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
            <EditorNote>被动硬件不由设备插件控制，仅用于接线建模。</EditorNote>
            <EditorPanel>
              <PortEditor ports={ports} onChange={setPorts} />
            </EditorPanel>
            {save.isError && <EditorAlert message={errorMessage(save.error)} />}
          </form>
        </DialogBody>
        <DialogFooter>
          <BundleActions
            kind="hardware"
            id={hardwareId}
            saved={Boolean(hardware)}
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
