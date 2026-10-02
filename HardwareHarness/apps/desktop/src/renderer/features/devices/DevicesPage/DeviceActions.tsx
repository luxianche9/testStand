import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Hardware, McpServerConfig, RemoteComputer, ServerStatus } from "@hardwareharness/contracts/devices";
import {
  ArrowUpCircleIcon, CircleAlertIcon, DownloadIcon, OctagonXIcon, PackageMinusIcon, PackagePlusIcon, PencilIcon,
  PlayIcon, PlusIcon, RefreshCwIcon, ScrollTextIcon, SquareIcon, Trash2Icon
} from "lucide-react";
import { errorMessage } from "../../../lib/errors.js";
import {
  Button, cn, Dialog, DialogBody, DialogContent, DialogFooter, IconButton, Spinner, StatusLamp, useConfirm
} from "../../../ui";
import { serviceStateLabel, serviceStateTone } from "./device-labels.js";
import { DeployServiceDialog } from "./editors/DeployDialogs.js";
import { ImportServicesDialog } from "./editors/ServiceDialogs.js";

/** Reported by every action group so the inspector shows one error strip under its header. */
export type ReportError = (message: string | null) => void;

export function ComputerActions({ computer, onEdit, onAddServer, onChanged, onError }: {
  computer: RemoteComputer;
  onEdit: () => void;
  onAddServer: () => void;
  onChanged: () => Promise<void>;
  onError: ReportError;
}) {
  const [confirm, confirmNode] = useConfirm();
  const [importOpen, setImportOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => window.hardwareharness.devices.removeComputer(computer.id),
    onMutate: () => onError(null),
    onError: (error) => onError(errorMessage(error)),
    onSettled: () => void onChanged()
  });
  const requestRemove = async () => {
    const ok = await confirm({
      title: "删除远程电脑",
      message: `删除 ${computer.label}？其下所有 MCP Server 配置会一并删除，远程文件不受影响。`,
      confirmLabel: "删除",
      danger: true
    });
    if (ok) remove.mutate();
  };
  return (
    <>
      <Button size="xs" aria-label="添加 MCP 服务器" onClick={onAddServer}><PlusIcon />添加 MCP Server</Button>
      {computer.ssh.shell === "powershell" && (
        <Button size="xs" title="读取这台电脑的 services.json，导入已安装的服务" onClick={() => setImportOpen(true)}>
          <DownloadIcon />从电脑导入
        </Button>
      )}
      {computer.ssh.shell === "powershell" && (
        <Button size="xs" title="打包适配器并安装为这台电脑上的服务" onClick={() => setDeployOpen(true)}>
          <PackagePlusIcon />部署服务
        </Button>
      )}
      <IconButton label="编辑电脑信息" size="icon-sm" onClick={onEdit}><PencilIcon /></IconButton>
      <IconButton label="删除远程电脑" size="icon-sm" disabled={remove.isPending} onClick={() => void requestRemove()}>
        <Trash2Icon />
      </IconButton>
      {confirmNode}
      {importOpen && (
        <ImportServicesDialog computer={computer} onClose={() => setImportOpen(false)} onChanged={onChanged} />
      )}
      {deployOpen && (
        <DeployServiceDialog computer={computer} onClose={() => setDeployOpen(false)} onChanged={onChanged} />
      )}
    </>
  );
}

/**
 * Header actions of a managed device: edit and delete the registration; a service deployed under a
 * root on a PowerShell computer can also be upgraded or uninstalled (§4.8.3).
 */
export function ServerActions({ server, computer, onEdit, onChanged, onError }: {
  server: McpServerConfig;
  computer?: RemoteComputer | undefined;
  onEdit: () => void;
  onChanged: () => Promise<void>;
  onError: ReportError;
}) {
  const [confirm, confirmNode] = useConfirm();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const deployed = Boolean(server.root) && computer?.ssh.shell === "powershell";
  const remove = useMutation({
    mutationFn: () => window.hardwareharness.devices.removeServer(server.serverId),
    onMutate: () => onError(null),
    onError: (error) => onError(errorMessage(error)),
    onSettled: () => void onChanged()
  });
  const requestRemove = async () => {
    const ok = await confirm({
      title: "删除 MCP Server",
      message: `删除 ${server.serverId}？远程文件不会被删除。`,
      confirmLabel: "删除",
      danger: true
    });
    if (ok) remove.mutate();
  };
  const uninstall = useMutation({
    mutationFn: () => window.hardwareharness.devices.uninstallService(server.serverId),
    onMutate: () => onError(null),
    onError: (error) => onError(errorMessage(error)),
    onSettled: () => void onChanged()
  });
  const requestUninstall = async () => {
    const ok = await confirm({
      title: "卸载服务",
      message: `卸载 ${server.serverId}？会先安全停止服务，注销后把 ${server.root} 打包备份到 `
        + "C:\\ProgramData\\HardwareHarness\\backup，再删除该目录和这里的配置。",
      confirmLabel: "卸载",
      danger: true
    });
    if (ok) uninstall.mutate();
  };
  return (
    <>
      {deployed && computer && (
        <>
          <Button size="xs" title="重新打包并升级这个服务，失败自动回滚" onClick={() => setUpgradeOpen(true)}>
            <ArrowUpCircleIcon />升级
          </Button>
          <Button size="xs" disabled={uninstall.isPending} onClick={() => void requestUninstall()}>
            <PackageMinusIcon />{uninstall.isPending ? "卸载中…" : "卸载"}
          </Button>
        </>
      )}
      <IconButton label="编辑信息" size="icon-sm" onClick={onEdit}><PencilIcon /></IconButton>
      <IconButton label="删除 MCP Server" size="icon-sm" disabled={remove.isPending} onClick={() => void requestRemove()}>
        <Trash2Icon />
      </IconButton>
      {confirmNode}
      {upgradeOpen && computer && (
        <DeployServiceDialog
          computer={computer}
          server={server}
          onClose={() => setUpgradeOpen(false)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

/** 服务 section body: process state lamp plus start / stop / force-stop / logs. */
export function ServiceControls({ server, status, sshOnline, onChanged, onError }: {
  server: McpServerConfig;
  status?: ServerStatus | undefined;
  sshOnline: boolean;
  onChanged: () => Promise<void>;
  onError: ReportError;
}) {
  const [stopFailed, setStopFailed] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const action = useMutation({
    mutationFn: (kind: "start" | "stop" | "force-stop") =>
      window.hardwareharness.devices.serverAction(server.serverId, kind),
    onMutate: () => onError(null),
    onSuccess: (_result, kind) => { if (kind !== "start") setStopFailed(false); },
    onError: (error, kind) => {
      if (kind === "stop") setStopFailed(true);
      onError(errorMessage(error));
    },
    onSettled: () => void onChanged()
  });
  const state = status?.service.serviceState;
  const transitioning = action.isPending || state === "starting" || state === "stopping";
  const gateTitle = (label: string) => (sshOnline ? label : "所属电脑连接检查通过后才能操作");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex h-7 min-w-[112px] items-center gap-2 rounded-md border border-line bg-surface-0 px-2">
        <StatusLamp tone={serviceStateTone(state)} pulse={transitioning} />
        <span className="text-xs text-fg">{serviceStateLabel(state)}</span>
        {action.isPending && <Spinner className="ml-auto size-3" />}
      </div>
      <Button
        size="xs"
        title={gateTitle("启动 MCP 服务")}
        aria-label="启动 MCP 服务"
        disabled={!sshOnline || action.isPending || state === "running"}
        onClick={() => action.mutate("start")}
      >
        <PlayIcon />启动
      </Button>
      <Button
        size="xs"
        title={gateTitle("终止 MCP 服务")}
        aria-label="终止 MCP 服务"
        disabled={!sshOnline || action.isPending || state === "stopped"}
        onClick={() => action.mutate("stop")}
      >
        <SquareIcon />停止
      </Button>
      {stopFailed && (
        <Button
          size="xs"
          variant="danger"
          title="安全停止失败，强制结束进程"
          aria-label="强制终止 MCP 服务"
          disabled={action.isPending}
          onClick={() => action.mutate("force-stop")}
        >
          <OctagonXIcon />强制停止
        </Button>
      )}
      <Button
        size="xs"
        variant="ghost"
        className="ml-auto"
        title={gateTitle("读取 MCP 服务日志")}
        disabled={!sshOnline}
        onClick={() => setLogsOpen(true)}
      >
        <ScrollTextIcon />服务日志
      </Button>
      {logsOpen && <ServiceLogDialog server={server} onClose={() => setLogsOpen(false)} />}
    </div>
  );
}

/** Logs live in a portal dialog so the inspector's sections keep a single `<pre>` (the tool result). */
function ServiceLogDialog({ server, onClose }: { server: McpServerConfig; onClose: () => void }) {
  const logs = useQuery({
    queryKey: ["devices", "server-logs", server.serverId],
    queryFn: () => window.hardwareharness.devices.readServerLogs(server.serverId, 200),
    gcTime: 0,
    retry: false
  });
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        title={`${server.label} 服务日志`}
        size="xl"
        actions={
          <IconButton label="重新读取" size="icon-sm" disabled={logs.isFetching} onClick={() => void logs.refetch()}>
            <RefreshCwIcon className={cn(logs.isFetching && "animate-spin")} />
          </IconButton>
        }
      >
        <DialogBody className="p-0">
          {logs.isPending && <div className="grid h-40 place-items-center"><Spinner label="正在读取日志…" /></div>}
          {logs.isError && (
            <p role="alert" className="flex items-start gap-2 px-4 py-3 text-xs text-fail">
              <CircleAlertIcon className="mt-0.5 size-3.5 flex-none" />{errorMessage(logs.error)}
            </p>
          )}
          {logs.data && (
            <div className="tf-num max-h-[60vh] overflow-auto bg-surface-0 px-4 py-2 text-2xs leading-4 whitespace-pre">
              {logs.data.truncated && <div className="text-fg-3">… 仅显示最近 {logs.data.lines.length} 行</div>}
              {logs.data.lines.length === 0 && <div className="text-fg-3">日志为空。</div>}
              {logs.data.lines.map((line, index) => <div key={index} className="text-fg-2">{line}</div>)}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <span className="tf-num mr-auto min-w-0 truncate text-2xs text-fg-3">{logs.data?.path}</span>
          <Button onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HardwareActions({ hardware, onEdit, onChanged, onError }: {
  hardware: Hardware;
  onEdit: (hardware: Hardware) => void;
  onChanged: () => Promise<void>;
  onError: ReportError;
}) {
  const [confirm, confirmNode] = useConfirm();
  const remove = useMutation({
    mutationFn: () => window.hardwareharness.devices.removeHardware(hardware.hardwareId),
    onMutate: () => onError(null),
    onError: (error) => onError(errorMessage(error)),
    onSettled: () => void onChanged()
  });
  const requestRemove = async () => {
    const ok = await confirm({
      title: "移除硬件",
      message: `移除 ${hardware.label}？端口、针脚和照片会一并删除，画布上引用它的节点会显示为未解析。`,
      confirmLabel: "移除",
      danger: true
    });
    if (ok) remove.mutate();
  };
  return (
    <>
      <Button size="xs" aria-label="编辑" onClick={() => onEdit(hardware)}><PencilIcon />编辑</Button>
      <IconButton label="移除硬件" size="icon-sm" disabled={remove.isPending} onClick={() => void requestRemove()}>
        <Trash2Icon />
      </IconButton>
      {confirmNode}
    </>
  );
}
