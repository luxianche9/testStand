import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import type { RemoteComputer } from "@testforge/contracts/devices";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { errorMessage } from "../../../../shared/errors.js";
import { IconAlert } from "../../../../shared/icons.js";
import { Btn, Modal } from "../../../../shared/ui.js";
import { EditorField } from "./EditorField.js";

const computerEditorSchema = z.object({
  id: z.string().trim().min(1, "请输入电脑 ID"),
  label: z.string().trim().min(1, "请输入显示名称"),
  address: z.string().trim().min(1, "请输入 IP 地址或主机名"),
  sshPort: z.string().regex(/^\d+$/, "请输入有效端口").refine((value) => {
    const port = Number(value);
    return port >= 1 && port <= 65_535;
  }, "端口必须在 1–65535 之间"),
  username: z.string().trim().min(1, "请输入 SSH 用户名"),
  shell: z.enum(["powershell", "posix"]),
  sshSecret: z.string()
});

type ComputerEditorValues = z.infer<typeof computerEditorSchema>;
const blankComputer: ComputerEditorValues = {
  id: "REMOTE_PC_1",
  label: "仪器控制电脑",
  address: "",
  sshPort: "22",
  username: "",
  shell: "powershell",
  sshSecret: ""
};

export function ComputerEditor({ open, computer, onClose, onChanged }: {
  open: boolean;
  computer?: RemoteComputer | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { register, reset, handleSubmit, formState: { errors, isValid } } = useForm<ComputerEditorValues>({
    resolver: zodResolver(computerEditorSchema),
    mode: "onChange",
    defaultValues: blankComputer
  });

  useEffect(() => {
    if (!open) return;
    reset(computer ? {
      id: computer.id,
      label: computer.label,
      address: computer.address,
      sshPort: String(computer.ssh.port),
      username: computer.ssh.username,
      shell: computer.ssh.shell,
      sshSecret: ""
    } : blankComputer);
  }, [computer, open, reset]);

  const save = useMutation({
    mutationFn: async (values: ComputerEditorValues) => {
      const input: RemoteComputer = {
        id: values.id.trim(),
        label: values.label.trim(),
        address: values.address.trim(),
        ssh: { port: Number(values.sshPort), username: values.username.trim(), shell: values.shell }
      };
      return window.testforge.devices.saveComputer(input, values.sshSecret ? { ssh: values.sshSecret } : undefined);
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
    title={computer ? "编辑远程电脑" : "添加远程电脑"}
    width={640}
    footer={<>
      <Btn onClick={onClose}>取消</Btn>
      <Btn type="submit" form="computer-editor-form" variant="primary" disabled={save.isPending || !isValid}>
        {save.isPending ? "保存中…" : "保存"}
      </Btn>
    </>}
  >
    <form id="computer-editor-form" className="form-grid" onSubmit={(event) => { void submit(event); }}>
      <EditorField label="电脑 ID" required error={errors.id?.message}><input className="input" {...register("id")} disabled={Boolean(computer)} /></EditorField>
      <EditorField label="显示名称" required error={errors.label?.message}><input className="input" {...register("label")} /></EditorField>
      <EditorField label="IP 地址 / 主机名" required error={errors.address?.message}><input className="input" {...register("address")} placeholder="192.168.3.51" /></EditorField>
      <EditorField label="SSH 端口" required error={errors.sshPort?.message}><input className="input" inputMode="numeric" {...register("sshPort")} /></EditorField>
      <EditorField label="SSH 用户名" required error={errors.username?.message}><input className="input" {...register("username")} /></EditorField>
      <EditorField label="远程 Shell" required error={errors.shell?.message}><select className="input" {...register("shell")}><option value="powershell">PowerShell</option><option value="posix">POSIX sh</option></select></EditorField>
      <EditorField label={computer ? "SSH 密码（留空保持不变）" : "SSH 密码"} error={errors.sshSecret?.message}><input className="input" type="password" {...register("sshSecret")} /></EditorField>
      <div className="span-2 form-note">MCP Server 在电脑保存后逐个添加，每个硬件对应一个独立 Server。</div>
      {save.isError && <div className="alert span-2"><IconAlert size={15} /><span>{errorMessage(save.error)}</span></div>}
    </form>
  </Modal>;
}
