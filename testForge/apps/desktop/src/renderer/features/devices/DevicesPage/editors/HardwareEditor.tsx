import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import type { Hardware, HardwarePort } from "@testforge/contracts/devices";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { errorMessage } from "../../../../shared/errors.js";
import { IconAlert } from "../../../../shared/icons.js";
import { Btn, Modal } from "../../../../shared/ui.js";
import { useDeviceCatalog } from "../../../../shared/queries.js";
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

  return <Modal
    open={open}
    onClose={onClose}
    title={hardware ? "编辑硬件" : "添加硬件"}
    width={760}
    footer={<>
      <BundleActions kind="hardware" id={hardwareId} saved={Boolean(live)} onChanged={async () => { await onChanged(); onClose(); }} />
      <Btn onClick={onClose}>取消</Btn>
      <Btn type="submit" form="hardware-editor-form" variant="primary" disabled={save.isPending || !isValid}>
        {save.isPending ? "保存中…" : "保存"}
      </Btn>
    </>}
  >
    <form id="hardware-editor-form" className="form-grid" onSubmit={(event) => { void submit(event); }}>
      <EditorField label="稳定 hardwareId" required error={errors.hardwareId?.message}><input className="input" {...register("hardwareId")} disabled={Boolean(hardware)} placeholder="DUT_1" /></EditorField>
      <EditorField label="显示名称" required error={errors.label?.message}><input className="input" {...register("label")} /></EditorField>
      <div className="span-2 form-note">被动硬件不由 MCP Server 控制，仅用于接线建模。</div>
      <div className="span-2 editor-assets">
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
      {save.isError && <div className="alert span-2"><IconAlert size={15} /><span>{errorMessage(save.error)}</span></div>}
    </form>
  </Modal>;
}
