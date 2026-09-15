import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Hardware, McpServerConfig, RemoteComputer, ServerStatus } from "@hardwareharness/contracts/devices";

import { CircleAlertIcon, PencilIcon, PlayIcon, PlusIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { errorMessage } from "../../../shared/errors.js";
import { Button } from "../../../shared/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../../../shared/ui/dialog";

export function ComputerActions({ computer, onEdit, onAddServer, onChanged }: {
  computer: RemoteComputer;
  onEdit: () => void;
  onAddServer: () => void;
  onChanged: () => Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => window.hardwareharness.devices.removeComputer(computer.id),
    onSuccess: () => setConfirmOpen(false),
    onSettled: () => void onChanged()
  });
  return <>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" aria-label="编辑电脑信息" onClick={onEdit}><PencilIcon />编辑</Button>
      <Button variant="outline" size="sm" aria-label="添加 MCP 服务器" onClick={onAddServer}><PlusIcon />添加 MCP Server</Button>
      <Button variant="destructive" size="sm" aria-label="删除远程电脑" onClick={() => setConfirmOpen(true)} disabled={remove.isPending}><Trash2Icon />删除</Button>
      {remove.isError && <span className="grid w-5 place-items-center text-destructive" title={errorMessage(remove.error)}><CircleAlertIcon className="size-3.5" /></span>}
    </div>
    <Dialog open={confirmOpen} onOpenChange={(value) => { if (!value) setConfirmOpen(false); }}>
      <DialogContent size="sm">
        <DialogHeader title="删除远程电脑" onClose={() => setConfirmOpen(false)} />
        <DialogBody><p className="m-0 text-sm">删除 {computer.label}？其下所有 MCP Server 配置会一并删除，远程文件不受影响。</p></DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmOpen(false)}>取消</Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>删除</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

export function ServerActions({ server, status, sshOnline, onEdit, onChanged }: {
  server: McpServerConfig;
  status?: ServerStatus | undefined;

  sshOnline: boolean;
  onEdit: () => void;
  onChanged: () => Promise<void>;
}) {
  const [stopFailed, setStopFailed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const action = useMutation({
    mutationFn: async (kind: "start" | "stop" | "force-stop" | "remove") => {
      if (kind === "remove") return window.hardwareharness.devices.removeServer(server.serverId);
      return window.hardwareharness.devices.serverAction(server.serverId, kind);
    },
    onSuccess: (_result, kind) => {
      if (kind === "stop" || kind === "force-stop") setStopFailed(false);
      if (kind === "remove") setConfirmOpen(false);
    },
    onError: (_error, kind) => { if (kind === "stop") setStopFailed(true); },
    onSettled: () => { void onChanged(); }
  });
  const gateTitle = (label: string) => (sshOnline ? label : "所属电脑连接检查通过后才能操作");
  return <>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" title={gateTitle("启动 MCP 服务")} aria-label="启动 MCP 服务" onClick={() => action.mutate("start")} disabled={!sshOnline || action.isPending || status?.service.serviceState === "running"}><PlayIcon />启动</Button>
      <Button variant="outline" size="sm" title={gateTitle("终止 MCP 服务")} aria-label="终止 MCP 服务" onClick={() => action.mutate("stop")} disabled={!sshOnline || action.isPending || status?.service.serviceState === "stopped"}><SquareIcon />停止</Button>
      {stopFailed && <Button variant="destructive" size="sm" title="安全停止失败，强制结束进程" aria-label="强制终止 MCP 服务" onClick={() => action.mutate("force-stop")} disabled={action.isPending}><CircleAlertIcon />强制停止</Button>}
      <Button variant="outline" size="sm" aria-label="编辑信息" onClick={onEdit}><PencilIcon />编辑</Button>
      <Button variant="destructive" size="sm" aria-label="删除 MCP Server" onClick={() => setConfirmOpen(true)} disabled={action.isPending}><Trash2Icon />删除</Button>
      {action.isError && <span className="grid w-5 place-items-center text-destructive" title={errorMessage(action.error)}><CircleAlertIcon className="size-3.5" /></span>}
    </div>
    <Dialog open={confirmOpen} onOpenChange={(value) => { if (!value) setConfirmOpen(false); }}>
      <DialogContent size="sm">
        <DialogHeader title="删除 MCP Server" onClose={() => setConfirmOpen(false)} />
        <DialogBody><p className="m-0 text-sm">删除 {server.serverId}？远程文件不会被删除。</p></DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmOpen(false)}>取消</Button>
          <Button variant="destructive" disabled={action.isPending} onClick={() => action.mutate("remove")}>删除</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

export function HardwareActions({ hardware, onEdit, onChanged }: {
  hardware: Hardware;
  onEdit: (hardware: Hardware) => void;
  onChanged: () => Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => window.hardwareharness.devices.removeHardware(hardware.hardwareId),
    onSuccess: () => setConfirmOpen(false),
    onSettled: () => void onChanged()
  });
  return <>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" aria-label="编辑" onClick={() => onEdit(hardware)}><PencilIcon />编辑</Button>
      <Button variant="destructive" size="sm" aria-label="移除硬件" onClick={() => setConfirmOpen(true)} disabled={remove.isPending}><Trash2Icon />移除</Button>
      {remove.isError && <span className="grid w-5 place-items-center text-destructive" title={errorMessage(remove.error)}><CircleAlertIcon className="size-3.5" /></span>}
    </div>
    <Dialog open={confirmOpen} onOpenChange={(value) => { if (!value) setConfirmOpen(false); }}>
      <DialogContent size="sm">
        <DialogHeader title="移除硬件" onClose={() => setConfirmOpen(false)} />
        <DialogBody><p className="m-0 text-sm">移除 {hardware.label}？端口、针脚和照片会一并删除，画布上引用它的节点会显示为未解析。</p></DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmOpen(false)}>取消</Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>移除</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
