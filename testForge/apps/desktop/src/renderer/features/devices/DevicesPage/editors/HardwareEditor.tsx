import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import type { Hardware, HardwarePort } from "@testforge/contracts/devices";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { CircleAlertIcon } from "lucide-react";
import { errorMessage } from "../../../../shared/errors.js";
import { useDeviceCatalog } from "../../../../shared/queries.js";
import { Button } from "../../../../shared/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../../../../shared/ui/dialog";
import { Input } from "../../../../shared/ui/input";
import { AppearanceImage, PortEditor } from "../../PortEditor.js";
import { BundleActions } from "../BundleActions.js";
import { EditorField } from "./EditorField.js";

const hardwareEditorSchema = z.object({
  hardwareId: z.string().trim().min(1, "请输入 hardwareId").refine((value) => !/\s/.test(value), "hardwareId 不能包含空格"),
  label: z.string().trim().min(1, "请输入显示名称")
});
type HardwareEditorValues = z.infer<typeof hardwareEditorSchema>;
const blankHardware: HardwareEditorValues = { hardwareId: "DUT_1", label: "被测对象" };

/** DUTs, fixtures and breakout boards: no MCP Server, no lease, just ports and photos. */
export function HardwareEditor({ open, hardware, onClose, onChanged }: {
  open: boolean;
  hardware?: Hardware | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const catalog = useDeviceCatalog();
  const [ports, setPorts] = useState<HardwarePort[]>([]);
  const { register, reset, watch, handleSubmit, formState: { errors, isValid } } = useForm<HardwareEditorValues>({
    resolver: zodResolver(hardwareEditorSchema),
    mode: "onChange",
    defaultValues: blankHardware
  });
  const hardwareId = watch("hardwareId");
  const live = hardware ? (catalog.data?.hardware.find((item) => item.hardwareId === hardware.hardwareId) ?? hardware) : undefined;

  useEffect(() => {
    if (!open) return;
    reset(hardware ? { hardwareId: hardware.hardwareId, label: hardware.label } : blankHardware);
    setPorts(hardware ? structuredClone(hardware.ports) : []);
  }, [hardware, open, reset]);

  const save = useMutation({
    mutationFn: async (values: HardwareEditorValues) => {
      const normalizedId = values.hardwareId.trim();
      return await window.testforge.devices.saveHardware({
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

  return <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
    <DialogContent size="lg" className="w-[760px]">
      <DialogHeader title={hardware ? "编辑硬件" : "添加硬件"} onClose={onClose} />
      <DialogBody>
        <form id="hardware-editor-form" className="grid grid-cols-2 gap-x-3.5 gap-y-3" onSubmit={(event) => { void submit(event); }}>
          <EditorField label="稳定 hardwareId" required error={errors.hardwareId?.message}><Input {...register("hardwareId")} disabled={Boolean(hardware)} placeholder="DUT_1" /></EditorField>
          <EditorField label="显示名称" required error={errors.label?.message}><Input {...register("label")} /></EditorField>
          <div className="col-span-2 text-xs leading-relaxed text-muted-foreground">被动硬件不由 MCP Server 控制，仅用于接线建模。</div>
          <div className="col-span-2 flex flex-col gap-2.5 rounded-md border bg-secondary/50 p-3">
            <AppearanceImage
              hardwareId={hardwareId}
              assetId={live?.appearanceAssetId}
              saved={Boolean(live)}
              onChanged={(item) => setPorts(structuredClone(item.ports))}
            />
            <PortEditor
              hardwareId={hardwareId}
              ports={ports}
              saved={Boolean(live)}
              onChange={setPorts}
              onImageChanged={(item) => setPorts(structuredClone(item.ports))}
            />
          </div>
          {save.isError && <div className="col-span-2 flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/6 px-3.5 py-2.5 text-xs break-words whitespace-pre-wrap text-destructive [&_svg]:mt-0.5 [&_svg]:flex-none"><CircleAlertIcon className="size-4" /><span>{errorMessage(save.error)}</span></div>}
        </form>
      </DialogBody>
      <DialogFooter>
        <BundleActions kind="hardware" id={hardwareId} saved={Boolean(live)} onChanged={async () => { await onChanged(); onClose(); }} />
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button type="submit" form="hardware-editor-form" disabled={save.isPending || !isValid}>
          {save.isPending ? "保存中…" : "保存"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
