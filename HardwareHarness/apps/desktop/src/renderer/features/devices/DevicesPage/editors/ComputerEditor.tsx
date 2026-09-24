import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import type { RemoteComputer } from "@hardwareharness/contracts/devices";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { errorMessage } from "../../../../lib/errors.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Input, Select } from "../../../../ui";
import { EditorAlert, EditorField, EditorNote, editorGrid } from "./EditorField.js";

const computerEditorSchema = z.object({
  execution: z.enum(["ssh", "local"]),
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
  execution: "ssh",
  id: "REMOTE_PC_1",
  label: "仪器控制电脑",
  address: "",
  sshPort: "22",
  username: "",
  shell: "powershell",
  sshSecret: ""
};

function valuesFor(computer: RemoteComputer): ComputerEditorValues {
  return {
    execution: computer.execution ?? "ssh",
    id: computer.id,
    label: computer.label,
    address: computer.address,
    sshPort: String(computer.ssh.port),
    username: computer.ssh.username,
    shell: computer.ssh.shell,
    sshSecret: ""
  };
}

export function ComputerEditor({ open, computer, onClose, onChanged }: {
  open: boolean;
  computer?: RemoteComputer | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { register, reset, watch, setValue, handleSubmit, formState } = useForm<ComputerEditorValues>({
    resolver: zodResolver(computerEditorSchema),
    mode: "onChange",
    defaultValues: blankComputer
  });
  const { errors, isValid } = formState;
  const isLocal = watch("execution") === "local";

  useEffect(() => {
    if (open) reset(computer ? valuesFor(computer) : blankComputer);
  }, [computer, open, reset]);

  const save = useMutation({
    mutationFn: async (values: ComputerEditorValues) => {
      const input: RemoteComputer = {
        execution: values.execution,
        id: values.id.trim(),
        label: values.label.trim(),
        address: values.execution === "local" ? "127.0.0.1" : values.address.trim(),
        ssh: { port: Number(values.sshPort), username: values.username.trim(), shell: values.shell }
      };
      const secret = values.sshSecret ? { ssh: values.sshSecret } : undefined;
      return window.hardwareharness.devices.saveComputer(input, secret);
    },
    onSuccess: async () => {
      await onChanged();
      onClose();
    }
  });
  const submit = handleSubmit(async (values) => { await save.mutateAsync(values); });
  const execution = register("execution", {
    onChange: (event: { target: { value: string } }) => {
      if (event.target.value !== "local") return;
      setValue("address", "127.0.0.1", { shouldValidate: true });
      setValue("username", "local", { shouldValidate: true });
      setValue("sshSecret", "");
    }
  });

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent title={computer ? "编辑电脑" : "添加电脑"} size="lg" className="w-[640px]">
        <DialogBody>
          <form id="computer-editor-form" className={editorGrid} onSubmit={(event) => { void submit(event); }}>
            <EditorField label="运行位置" required>
              <Select {...execution}>
                <option value="ssh">远程电脑（SSH）</option>
                <option value="local">本机</option>
              </Select>
            </EditorField>
            <EditorField label="电脑 ID" required error={errors.id?.message}>
              <Input className="font-mono" {...register("id")} disabled={Boolean(computer)} />
            </EditorField>
            <EditorField label="显示名称" required error={errors.label?.message}>
              <Input {...register("label")} />
            </EditorField>
            {!isLocal && (
              <>
                <EditorField label="IP 地址 / 主机名" required error={errors.address?.message}>
                  <Input className="font-mono" {...register("address")} placeholder="192.168.3.51" />
                </EditorField>
                <EditorField label="SSH 端口" required error={errors.sshPort?.message}>
                  <Input className="font-mono" inputMode="numeric" {...register("sshPort")} />
                </EditorField>
                <EditorField label="SSH 用户名" required error={errors.username?.message}>
                  <Input {...register("username")} />
                </EditorField>
                <EditorField label={computer ? "SSH 密码（留空保持不变）" : "SSH 密码"} error={errors.sshSecret?.message}>
                  <Input type="password" {...register("sshSecret")} />
                </EditorField>
              </>
            )}
            <EditorField label="Shell" required error={errors.shell?.message}>
              <Select {...register("shell")}>
                <option value="powershell">PowerShell</option>
                <option value="posix">POSIX sh</option>
              </Select>
            </EditorField>
            <EditorNote>MCP Server 在电脑保存后逐个添加，每个硬件对应一个独立 Server。</EditorNote>
            {save.isError && <EditorAlert message={errorMessage(save.error)} />}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" form="computer-editor-form" disabled={save.isPending || !isValid}>
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
