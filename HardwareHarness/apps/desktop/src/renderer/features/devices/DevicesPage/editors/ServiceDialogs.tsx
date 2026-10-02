import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { RemoteComputer, ServiceImportResult } from "@hardwareharness/contracts/devices";
import { errorMessage } from "../../../../lib/errors.js";
import { Button, Checkbox, Dialog, DialogBody, DialogContent, DialogFooter, Input, Spinner } from "../../../../ui";
import { EditorAlert, EditorField, EditorNote, editorGrid } from "./EditorField.js";

/** An existing service reached only through its URL: HardwareHarness uses it but never starts or stops it. */
export function AddServerByUrlDialog({ open, onClose, onAdded }: {
  open: boolean;
  onClose: () => void;
  onAdded: (serverId: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const add = useMutation({
    mutationFn: () => window.hardwareharness.devices.addServerByUrl(url.trim(), token, label.trim() || undefined),
    onSuccess: async (result) => {
      await onAdded(result.server.serverId);
      onClose();
    }
  });
  const { reset } = add;
  useEffect(() => {
    if (!open) return;
    setUrl("");
    setToken("");
    setLabel("");
    reset();
  }, [open, reset]);
  const ready = /^https?:\/\/\S+$/.test(url.trim()) && token.length > 0;
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent title="按 URL 添加服务" size="lg" className="w-[560px]">
        <DialogBody>
          <form
            id="add-by-url-form"
            className={editorGrid}
            onSubmit={(event) => { event.preventDefault(); if (ready) add.mutate(); }}
          >
            <EditorField label="服务地址" required span hint="例如 http://192.168.3.63:8011，末尾的 /mcp 可省略">
              <Input className="font-mono" value={url} onChange={(event) => setUrl(event.target.value)} />
            </EditorField>
            <EditorField label="访问令牌" required>
              <Input type="password" value={token} onChange={(event) => setToken(event.target.value)} />
            </EditorField>
            <EditorField label="显示名称" hint="留空则用服务报告的厂商与型号">
              <Input value={label} onChange={(event) => setLabel(event.target.value)} />
            </EditorField>
            <EditorNote>
              先读 /health 确认服务身份，再用令牌读 /device。令牌只存入系统凭据库。这样添加的服务没有所属电脑，
              界面显示“未托管”，不能在这里启动或停止。
            </EditorNote>
            {add.isError && <EditorAlert message={errorMessage(add.error)} />}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" form="add-by-url-form" disabled={add.isPending || !ready}>
            {add.isPending ? "连接中…" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Services listed in a computer's services.json; the chosen ones are added with their own tokens. */
export function ImportServicesDialog({ computer, onClose, onChanged }: {
  computer: RemoteComputer;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ServiceImportResult | null>(null);
  const found = useQuery({
    queryKey: ["devices", "discover-services", computer.id],
    queryFn: () => window.hardwareharness.devices.discoverServices(computer.id),
    gcTime: 0,
    retry: false
  });
  const importing = useMutation({
    mutationFn: () => window.hardwareharness.devices.importServices(computer.id, [...chosen]),
    onSuccess: async (value) => {
      setResult(value);
      setChosen(new Set());
      await onChanged();
      await found.refetch();
    }
  });
  const toggle = (serverId: string, on: boolean) => setChosen((current) => {
    const next = new Set(current);
    if (on) next.add(serverId); else next.delete(serverId);
    return next;
  });
  const services = found.data ?? [];
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent title={`从 ${computer.label} 导入服务`} size="lg" className="w-[640px]">
        <DialogBody className="grid gap-3">
          {found.isPending && (
            <div className="grid h-24 place-items-center"><Spinner label="正在读取 services.json…" /></div>
          )}
          {found.isError && <EditorAlert message={errorMessage(found.error)} />}
          {found.isSuccess && services.length === 0 && (
            <p className="text-xs text-fg-3">这台电脑的 services.json 里没有已安装的服务。</p>
          )}
          {services.length > 0 && (
            <ul aria-label="已安装的服务" className="overflow-hidden rounded-md border border-line">
              {services.map((service) => (
                <li key={service.serverId} className="border-b border-line last:border-b-0">
                  <label className="flex items-center gap-2 px-2 py-1.5 text-sm text-fg-2">
                    <Checkbox
                      aria-label={service.serverId}
                      disabled={service.added || importing.isPending}
                      checked={service.added || chosen.has(service.serverId)}
                      onCheckedChange={(value) => toggle(service.serverId, value === true)}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono" title={service.root}>{service.serverId}</span>
                    <span className="tf-num text-2xs text-fg-3">
                      {service.adapterVersion ? `v${service.adapterVersion} · ` : ""}:{service.port}
                    </span>
                    {service.added && <span className="text-2xs text-fg-3">已添加</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {result && <ImportSummary result={result} />}
          {importing.isError && <EditorAlert message={errorMessage(importing.error)} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          <Button
            variant="primary"
            disabled={importing.isPending || chosen.size === 0}
            onClick={() => importing.mutate()}
          >
            {importing.isPending ? "导入中…" : `导入 ${chosen.size || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportSummary({ result }: { result: ServiceImportResult }) {
  return (
    <div role="status" className={editorGrid}>
      <EditorNote>已导入 {result.imported.length} 个服务。</EditorNote>
      {result.skipped.map((item) => (
        <EditorAlert key={item.serverId} message={`${item.serverId}：${item.reason}`} />
      ))}
    </div>
  );
}
