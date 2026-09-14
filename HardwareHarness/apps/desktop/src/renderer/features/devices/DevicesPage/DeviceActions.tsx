import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Hardware, McpServerConfig, RemoteComputer, ServerStatus } from "@hardwareharness/contracts/devices";
import type { HardwareOccupancyStatus } from "@hardwareharness/contracts/occupancy";
import { CircleAlertIcon, LockKeyholeIcon, LockOpenIcon, PencilIcon, PlayIcon, PlusIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { errorMessage } from "../../../shared/errors.js";
import { Button } from "../../../shared/ui/button";
import { TooltipIconButton } from "../../../shared/ui/checkbox";
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
  const open = (handler: () => void) => (event: React.MouseEvent) => { event.stopPropagation(); handler(); };
  return <>
    <span className="flex flex-none items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
      <TooltipIconButton tooltip="编辑电脑信息" aria-label="编辑电脑信息" onClick={open(onEdit)}><PencilIcon /></TooltipIconButton>
      <TooltipIconButton tooltip="添加 MCP 服务器" aria-label="添加 MCP 服务器" className="text-primary" onClick={open(onAddServer)}><PlusIcon /></TooltipIconButton>
      <TooltipIconButton tooltip="删除远程电脑及其全部 MCP Server（远程文件不会被删除）" aria-label="删除远程电脑" onClick={open(() => setConfirmOpen(true))} disabled={remove.isPending}><Trash2Icon /></TooltipIconButton>
      {remove.isError && <span className="grid w-5 place-items-center text-destructive" title={errorMessage(remove.error)}><CircleAlertIcon className="size-3.5" /></span>}
    </span>
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

export function ServerActions({ server, status, occupancy, hardwareExecuting, sshOnline, onEdit, onChanged }: {
  server: McpServerConfig;
  status?: ServerStatus | undefined;
  occupancy?: HardwareOccupancyStatus | undefined;
  hardwareExecuting: boolean;
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
  const occupancyAction = useMutation({
    mutationFn: () => occupancy?.state === "occupied_by_self"
      ? window.hardwareharness.occupancy.release(server.hardwareId)
      : window.hardwareharness.occupancy.acquire(server.hardwareId),
    onSettled: () => { void onChanged(); }
  });
  const fire = (kind: "start" | "stop" | "force-stop") => (event: React.MouseEvent) => { event.stopPropagation(); action.mutate(kind); };
  const open = (handler: () => void) => (event: React.MouseEvent) => { event.stopPropagation(); handler(); };
  const gateTitle = (label: string) => (sshOnline ? label : "所属电脑连接检查通过后才能操作");
  const occupancyOnline = status?.transport.state === "online";
  const held = occupancy?.state === "occupied_by_self";
  const occupancyDisabled = occupancyAction.isPending || !occupancyOnline || (!held && occupancy?.state !== "unoccupied") || (held && hardwareExecuting);
  const occupancyTitle = !occupancyOnline ? "MCP Server 在线后才能占用硬件"
    : held && hardwareExecuting ? "硬件正在执行；先结束手动调用或取消 Run"
      : occupancy?.state === "occupied_elsewhere" ? `已被 ${occupancy.holderLabel ?? "其他客户端"} 占用`
        : occupancy?.state === "unknown" || !occupancy ? "占用状态未知，请先刷新状态"
          : held ? "释放硬件并进入安全态" : "人工占用硬件";
  return <>
    <span className="flex flex-none items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
      <TooltipIconButton tooltip={occupancyTitle} aria-label={held ? "释放硬件" : "占用硬件"} className={held ? "text-primary" : undefined} onClick={(event) => { event.stopPropagation(); occupancyAction.mutate(); }} disabled={occupancyDisabled}>{held ? <LockOpenIcon /> : <LockKeyholeIcon />}</TooltipIconButton>
      <TooltipIconButton tooltip={gateTitle("启动 MCP 服务")} aria-label="启动 MCP 服务" className="text-primary" onClick={fire("start")} disabled={!sshOnline || action.isPending || status?.service.serviceState === "running"}><PlayIcon /></TooltipIconButton>
      <TooltipIconButton tooltip={gateTitle("终止 MCP 服务")} aria-label="终止 MCP 服务" onClick={fire("stop")} disabled={!sshOnline || action.isPending || status?.service.serviceState === "stopped"}><SquareIcon /></TooltipIconButton>
      {stopFailed && <TooltipIconButton tooltip="安全停止失败，强制结束进程" aria-label="强制终止 MCP 服务" className="text-destructive" onClick={fire("force-stop")} disabled={action.isPending}><CircleAlertIcon /></TooltipIconButton>}
      <TooltipIconButton tooltip="编辑信息" aria-label="编辑信息" onClick={open(onEdit)}><PencilIcon /></TooltipIconButton>
      <TooltipIconButton tooltip="删除该 MCP Server（不会删除远程文件）" aria-label="删除 MCP Server" onClick={open(() => setConfirmOpen(true))} disabled={action.isPending}><Trash2Icon /></TooltipIconButton>
      {action.isError && <span className="grid w-5 place-items-center text-destructive" title={errorMessage(action.error)}><CircleAlertIcon className="size-3.5" /></span>}
      {occupancyAction.isError && <span className="grid w-5 place-items-center text-destructive" title={errorMessage(occupancyAction.error)}><CircleAlertIcon className="size-3.5" /></span>}
    </span>
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
    <span className="flex flex-none items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
      <TooltipIconButton tooltip="编辑" aria-label="编辑" onClick={(event) => { event.stopPropagation(); onEdit(hardware); }}><PencilIcon /></TooltipIconButton>
      <TooltipIconButton tooltip="移除该硬件" aria-label="移除硬件" onClick={(event) => { event.stopPropagation(); setConfirmOpen(true); }} disabled={remove.isPending}><Trash2Icon /></TooltipIconButton>
      {remove.isError && <span className="grid w-5 place-items-center text-destructive" title={errorMessage(remove.error)}><CircleAlertIcon className="size-3.5" /></span>}
    </span>
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
