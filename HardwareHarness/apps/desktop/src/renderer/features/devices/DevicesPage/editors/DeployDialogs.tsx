import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  DeployResult, DeployServiceSpec, DeployStep, McpHttpServerConfig, RemoteComputer
} from "@hardwareharness/contracts/devices";
import { CheckIcon, MinusIcon, XIcon } from "lucide-react";
import { errorMessage } from "../../../../lib/errors.js";
import {
  Button, Checkbox, Dialog, DialogBody, DialogContent, DialogFooter, Input, Select, Spinner
} from "../../../../ui";
import { EditorAlert, EditorField, EditorNote, editorGrid } from "./EditorField.js";

function portOf(url: string | undefined): string {
  try {
    return url ? new URL(url).port : "";
  } catch {
    return "";
  }
}

/** Upgrading keeps the adapter; guess it from the Server ID (`PCI1762_MCP` → `pci1762`). */
function guessAdapter(serverId: string, adapters: string[]): string {
  const name = serverId.toLowerCase();
  return adapters.find((adapter) => name.startsWith(adapter)) ?? "";
}

/**
 * Builds the adapter bundle, uploads it and runs the install scripts (§4.8.3). With `server` it
 * upgrades that service in place: identity and root stay, the remote server.json and token are kept.
 */
export function DeployServiceDialog({ computer, server, onClose, onChanged }: {
  computer: RemoteComputer;
  server?: McpHttpServerConfig;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const upgrade = Boolean(server);
  const [adapter, setAdapter] = useState("");
  const [serverId, setServerId] = useState(server?.serverId ?? "");
  const [hardwareId, setHardwareId] = useState(server?.hardwareId ?? "");
  const [port, setPort] = useState(portOf(server?.url));
  const [root, setRoot] = useState(server?.root ?? "");
  const [label, setLabel] = useState(server?.label ?? "");
  const [dryRun, setDryRun] = useState(false);
  const [autostart, setAutostart] = useState(true);
  const [result, setResult] = useState<DeployResult | null>(null);
  const adapters = useQuery({
    queryKey: ["devices", "adapters"],
    queryFn: () => window.hardwareharness.devices.listAdapters(),
    retry: false
  });
  const names = (adapters.data ?? []).map((item) => item.adapter);
  const chosen = adapter || (server ? guessAdapter(server.serverId, names) : "");
  const deploy = useMutation({
    mutationFn: () => {
      const spec: DeployServiceSpec = {
        serverId: serverId.trim(), hardwareId: hardwareId.trim(), adapter: chosen, port: Number(port), dryRun, autostart
      };
      if (root.trim()) spec.root = root.trim();
      if (label.trim()) spec.label = label.trim();
      return window.hardwareharness.devices.deployService(computer.id, spec);
    },
    onSuccess: async (value) => {
      setResult(value);
      await onChanged();
    }
  });
  const portNumber = Number(port);
  const ready = Boolean(chosen && serverId.trim() && hardwareId.trim())
    && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const failedSteps = deploy.error && typeof deploy.error === "object" && "details" in deploy.error
    ? ((deploy.error as { details?: { steps?: DeployStep[] } }).details?.steps ?? [])
    : [];
  const busy = deploy.isPending;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent
        title={upgrade ? `升级 ${server?.label ?? ""}` : `部署服务到 ${computer.label}`}
        size="lg"
        className="w-[640px]"
      >
        <DialogBody>
          <form
            id="deploy-service-form"
            className={editorGrid}
            onSubmit={(event) => { event.preventDefault(); if (ready && !busy) deploy.mutate(); }}
          >
            <EditorField label="适配器" required>
              <Select
                aria-label="适配器"
                value={chosen}
                disabled={busy}
                onChange={(event) => setAdapter(event.target.value)}
              >
                <option value="">{adapters.isPending ? "读取中…" : "选择适配器"}</option>
                {(adapters.data ?? []).map((item) => (
                  <option key={item.adapter} value={item.adapter}>{item.adapter} · v{item.version}</option>
                ))}
              </Select>
            </EditorField>
            <EditorField label="端口" required>
              <Input
                aria-label="端口"
                className="font-mono"
                inputMode="numeric"
                value={port}
                disabled={busy || upgrade}
                onChange={(event) => setPort(event.target.value)}
              />
            </EditorField>
            <EditorField label="Server ID" required>
              <Input
                aria-label="Server ID"
                className="font-mono"
                value={serverId}
                disabled={busy || upgrade}
                onChange={(event) => setServerId(event.target.value)}
              />
            </EditorField>
            <EditorField label="硬件 ID" required>
              <Input
                aria-label="硬件 ID"
                className="font-mono"
                value={hardwareId}
                disabled={busy || upgrade}
                onChange={(event) => setHardwareId(event.target.value)}
              />
            </EditorField>
            <EditorField label="安装目录" hint="留空则用 E:\<server id>_server">
              <Input
                aria-label="安装目录"
                className="font-mono"
                value={root}
                disabled={busy || upgrade}
                onChange={(event) => setRoot(event.target.value)}
              />
            </EditorField>
            <EditorField label="显示名称" hint="留空则用厂商与型号">
              <Input
                aria-label="显示名称"
                value={label}
                disabled={busy}
                onChange={(event) => setLabel(event.target.value)}
              />
            </EditorField>
            <div className="col-span-2 flex flex-wrap gap-4 text-xs text-fg-2">
              <label className="flex items-center gap-2">
                <Checkbox
                  aria-label="开机自启"
                  checked={autostart}
                  disabled={busy}
                  onCheckedChange={(value) => setAutostart(value === true)}
                />
                开机自启
              </label>
              {!upgrade && (
                <label className="flex items-center gap-2" title="写入 server.json 的 dryRun，服务用模拟驱动运行，不碰硬件">
                  <Checkbox
                    aria-label="使用模拟驱动"
                    checked={dryRun}
                    disabled={busy}
                    onCheckedChange={(value) => setDryRun(value === true)}
                  />
                  使用模拟驱动（dry run）
                </label>
              )}
            </div>
            <EditorNote>
              {upgrade
                ? "升级会先安全停止旧服务并备份，失败时自动回滚；远程 server.json 和令牌保持不变。"
                : "新部署会在远程生成 server.json 和访问令牌，令牌只存入系统凭据库。打包和安装可能需要几分钟。"}
            </EditorNote>
            {adapters.isError && <EditorAlert message={errorMessage(adapters.error)} />}
            {deploy.isError && <EditorAlert message={errorMessage(deploy.error)} />}
            {busy && (
              <div className="col-span-2 flex items-center gap-2 text-xs text-fg-3">
                <Spinner className="size-3" />正在打包、上传并安装…
              </div>
            )}
            {(result?.steps ?? failedSteps).length > 0 && <DeploySteps steps={result?.steps ?? failedSteps} />}
            {result && (
              <EditorNote>
                已{result.upgraded ? "升级" : "部署"}到 {result.root}，端口 {result.port}。
              </EditorNote>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{result ? "完成" : "取消"}</Button>
          <Button variant="primary" type="submit" form="deploy-service-form" disabled={busy || !ready}>
            {busy ? "部署中…" : upgrade ? "升级" : "部署"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeploySteps({ steps }: { steps: DeployStep[] }) {
  return (
    <ol aria-label="部署步骤" className="col-span-2 grid gap-0.5 rounded-md border border-line bg-surface-0 px-3 py-2">
      {steps.map((item, index) => (
        <li key={index} className="flex items-start gap-2 text-2xs text-fg-2">
          {item.skipped ? (
            <MinusIcon className="mt-0.5 size-3 flex-none text-fg-3" />
          ) : item.ok ? (
            <CheckIcon className="mt-0.5 size-3 flex-none text-pass" />
          ) : (
            <XIcon className="mt-0.5 size-3 flex-none text-fail" />
          )}
          <span className="font-mono">{item.step}</span>
          {(item.skipped ?? item.message) && (
            <span className="min-w-0 break-words text-fg-3">{item.skipped ?? item.message}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
