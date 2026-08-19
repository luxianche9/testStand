import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import type { RemoteComputer } from "@testforge/contracts/devices";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { CircleAlertIcon } from "lucide-react";
import { errorMessage } from "../../../../shared/errors.js";
import { Button } from "../../../../shared/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../../../../shared/ui/dialog";
import { Input, Select } from "../../../../shared/ui/input";
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

  return <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
    <DialogContent size="default" className="w-[640px]">
      <DialogHeader title={computer ? "编辑远程电脑" : "添加远程电脑"} onClose={onClose} />
      <DialogBody>
        <form id="computer-editor-form" className="grid grid-cols-2 gap-x-3.5 gap-y-3" onSubmit={(event) => { void submit(event); }}>
          <EditorField label="电脑 ID" required error={errors.id?.message}><Input {...register("id")} disabled={Boolean(computer)} /></EditorField>
          <EditorField label="显示名称" required error={errors.label?.message}><Input {...register("label")} /></EditorField>
          <EditorField label="IP 地址 / 主机名" required error={errors.address?.message}><Input {...register("address")} placeholder="192.168.3.51" /></EditorField>
          <EditorField label="SSH 端口" required error={errors.sshPort?.message}><Input inputMode="numeric" {...register("sshPort")} /></EditorField>
          <EditorField label="SSH 用户名" required error={errors.username?.message}><Input {...register("username")} /></EditorField>
          <EditorField label="远程 Shell" required error={errors.shell?.message}><Select {...register("shell")}><option value="powershell">PowerShell</option><option value="posix">POSIX sh</option></Select></EditorField>
          <EditorField label={computer ? "SSH 密码（留空保持不变）" : "SSH 密码"} error={errors.sshSecret?.message}><Input type="password" {...register("sshSecret")} /></EditorField>
          <div className="col-span-2 text-xs leading-relaxed text-muted-foreground">MCP Server 在电脑保存后逐个添加，每个硬件对应一个独立 Server。</div>
          {save.isError && <div className="col-span-2 flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/6 px-3.5 py-2.5 text-xs break-words whitespace-pre-wrap text-destructive [&_svg]:mt-0.5 [&_svg]:flex-none"><CircleAlertIcon className="size-4" /><span>{errorMessage(save.error)}</span></div>}
        </form>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button type="submit" form="computer-editor-form" disabled={save.isPending || !isValid}>
          {save.isPending ? "保存中…" : "保存"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
