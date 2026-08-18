import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Hardware, McpServerConfig, RemoteComputer, ServerStatus } from "@testforge/contracts/devices";
import type { HardwareOccupancyStatus } from "@testforge/contracts/occupancy";
import { LockKeyholeIcon, LockOpenIcon } from "lucide-react";
import { errorMessage } from "../../../shared/errors.js";
import { IconAlert, IconEdit, IconPlay, IconPlus, IconStop, IconTrash } from "../../../shared/icons.js";
import { Btn, Modal } from "../../../shared/ui.js";

export function ComputerActions({ computer, onEdit, onAddServer, onChanged }: {
  computer: RemoteComputer;
  onEdit: () => void;
  onAddServer: () => void;
  onChanged: () => Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => window.testforge.devices.removeComputer(computer.id),
    onSuccess: () => setConfirmOpen(false),
    onSettled: () => void onChanged()
  });
  const open = (handler: () => void) => (event: React.MouseEvent) => { event.stopPropagation(); handler(); };
  return <>
    <span className="row-actions" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="row-action" title="编辑 SSH 信息" aria-label="编辑 SSH 信息" onClick={open(onEdit)}><IconEdit size={14} /></button>
      <button type="button" className="row-action accent" title="添加 MCP 服务器" aria-label="添加 MCP 服务器" onClick={open(onAddServer)}><IconPlus size={14} /></button>
      <button type="button" className="row-action" title="删除远程电脑及其全部 MCP Server（远程文件不会被删除）" aria-label="删除远程电脑" onClick={open(() => setConfirmOpen(true))} disabled={remove.isPending}><IconTrash size={14} /></button>
      {remove.isError && <span className="row-error" title={errorMessage(remove.error)}><IconAlert size={14} /></span>}
    </span>
    <Modal
      open={confirmOpen}
      onClose={() => setConfirmOpen(false)}
      title="删除远程电脑"
      footer={<><Btn onClick={() => setConfirmOpen(false)}>取消</Btn><Btn variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>删除</Btn></>}
    ><p>删除 {computer.label}？其下所有 MCP Server 配置会一并删除，远程文件不受影响。</p></Modal>
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
      if (kind === "remove") return window.testforge.devices.removeServer(server.serverId);
      return window.testforge.devices.serverAction(server.serverId, kind);
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
      ? window.testforge.occupancy.release(server.hardwareId)
      : window.testforge.occupancy.acquire(server.hardwareId),
    onSettled: () => { void onChanged(); }
  });
  const fire = (kind: "start" | "stop" | "force-stop") => (event: React.MouseEvent) => { event.stopPropagation(); action.mutate(kind); };
  const open = (handler: () => void) => (event: React.MouseEvent) => { event.stopPropagation(); handler(); };
  const gateTitle = (label: string) => (sshOnline ? label : "所属电脑 SSH 在线后才能操作");
  const occupancyOnline = status?.transport.state === "online";
  const held = occupancy?.state === "occupied_by_self";
  const occupancyDisabled = occupancyAction.isPending || !occupancyOnline || (!held && occupancy?.state !== "unoccupied") || (held && hardwareExecuting);
  const occupancyTitle = !occupancyOnline ? "MCP Server 在线后才能占用硬件"
    : held && hardwareExecuting ? "硬件正在执行；先结束手动调用或取消 Run"
      : occupancy?.state === "occupied_elsewhere" ? `已被 ${occupancy.holderLabel ?? "其他客户端"} 占用`
        : occupancy?.state === "unknown" || !occupancy ? "占用状态未知，请先刷新状态"
          : held ? "释放硬件并进入安全态" : "人工占用硬件";
  return <>
    <span className="row-actions" onClick={(event) => event.stopPropagation()}>
      <button type="button" className={`row-action${held ? " accent" : ""}`} title={occupancyTitle} aria-label={held ? "释放硬件" : "占用硬件"} onClick={(event) => { event.stopPropagation(); occupancyAction.mutate(); }} disabled={occupancyDisabled}>{held ? <LockOpenIcon size={13} /> : <LockKeyholeIcon size={13} />}</button>
      <button type="button" className="row-action accent" title={gateTitle("启动 MCP 服务")} aria-label="启动 MCP 服务" onClick={fire("start")} disabled={!sshOnline || action.isPending || status?.service.serviceState === "running"}><IconPlay size={13} /></button>
      <button type="button" className="row-action" title={gateTitle("终止 MCP 服务")} aria-label="终止 MCP 服务" onClick={fire("stop")} disabled={!sshOnline || action.isPending || status?.service.serviceState === "stopped"}><IconStop size={13} /></button>
      {stopFailed && <button type="button" className="row-action danger" title="安全停止失败，强制结束进程" aria-label="强制终止 MCP 服务" onClick={fire("force-stop")} disabled={action.isPending}><IconAlert size={14} /></button>}
      <button type="button" className="row-action" title="编辑信息" aria-label="编辑信息" onClick={open(onEdit)}><IconEdit size={14} /></button>
      <button type="button" className="row-action" title="删除该 MCP Server（不会删除远程文件）" aria-label="删除 MCP Server" onClick={open(() => setConfirmOpen(true))} disabled={action.isPending}><IconTrash size={14} /></button>
      {action.isError && <span className="row-error" title={errorMessage(action.error)}><IconAlert size={14} /></span>}
      {occupancyAction.isError && <span className="row-error" title={errorMessage(occupancyAction.error)}><IconAlert size={14} /></span>}
    </span>
    <Modal
      open={confirmOpen}
      onClose={() => setConfirmOpen(false)}
      title="删除 MCP Server"
      footer={<><Btn onClick={() => setConfirmOpen(false)}>取消</Btn><Btn variant="danger" disabled={action.isPending} onClick={() => action.mutate("remove")}>删除</Btn></>}
    ><p>删除 {server.serverId}？远程文件不会被删除。</p></Modal>
  </>;
}

export function HardwareActions({ hardware, onEdit, onChanged }: {
  hardware: Hardware;
  onEdit: (hardware: Hardware) => void;
  onChanged: () => Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => window.testforge.devices.removeHardware(hardware.hardwareId),
    onSuccess: () => setConfirmOpen(false),
    onSettled: () => void onChanged()
  });
  return <>
    <span className="row-actions" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="row-action" title="编辑" aria-label="编辑" onClick={(event) => { event.stopPropagation(); onEdit(hardware); }}><IconEdit size={14} /></button>
      <button type="button" className="row-action" title="移除该硬件" aria-label="移除硬件" onClick={(event) => { event.stopPropagation(); setConfirmOpen(true); }} disabled={remove.isPending}><IconTrash size={14} /></button>
      {remove.isError && <span className="row-error" title={errorMessage(remove.error)}><IconAlert size={14} /></span>}
    </span>
    <Modal
      open={confirmOpen}
      onClose={() => setConfirmOpen(false)}
      title="移除硬件"
      footer={<><Btn onClick={() => setConfirmOpen(false)}>取消</Btn><Btn variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>移除</Btn></>}
    ><p>移除 {hardware.label}？端口、针脚和照片会一并删除，画布上引用它的节点会显示为未解析。</p></Modal>
  </>;
}
