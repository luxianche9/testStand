import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { DeviceBundlePreview, Hardware, HardwarePort, McpServerConfig, RemoteComputer } from "@testforge/contracts/devices";
import { errorMessage } from "../../../../shared/errors.js";
import { hardwareForServer } from "../../../../shared/hardware.js";
import { IconAlert, IconCopy, IconDownload } from "../../../../shared/icons.js";
import { Btn, Modal } from "../../../../shared/ui.js";
import { AppearanceImage, PortEditor } from "../../PortEditor.js";
import { EditorField } from "./EditorField.js";

function serverDefaults(serverId: string) {
  const hardwareName = serverId.replace(/_MCP$/, "").toLowerCase();
  const root = `E:\\${hardwareName}_mcp_server`;
  return {
    statusCommand: `& '${root}\\status.ps1'`,
    startCommand: `& '${root}\\start.ps1'`,
    stopCommand: `& '${root}\\stop.ps1'`,
    logPath: `${root}\\logs`
  };
}

/** A server and the single managed hardware device it drives are edited together. */
export function ServerEditor({ open, server, computerId, computers, hardware, onClose, onChanged }: {
  open: boolean;
  server?: McpServerConfig | undefined;
  computerId?: string | undefined;
  computers: RemoteComputer[];
  hardware: Hardware[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const blank = {
    serverId: "",
    computerId: computerId ?? computers[0]?.id ?? "",
    label: "",
    hardwareId: "",
    url: "",
    mcpToken: "",
    ...serverDefaults("")
  };
  const [form, setForm] = useState(blank);
  const [ports, setPorts] = useState<HardwarePort[]>([]);
  const [pathsTouched, setPathsTouched] = useState(false);
  const [bundlePreview, setBundlePreview] = useState<DeviceBundlePreview>();
  const [bundleNotice, setBundleNotice] = useState<string>();

  const live = server ? hardwareForServer(server, hardware) : undefined;
  const selectedHardware = live ?? hardware.find((item) => item.hardwareId === form.hardwareId);
  useEffect(() => {
    if (!open) return;
    setPathsTouched(Boolean(server));
    setForm(server
      ? { serverId: server.serverId, computerId: server.computerId, label: server.label, hardwareId: server.hardwareId, url: server.url, mcpToken: "", ...server.lifecycle }
      : { ...blank, computerId: computerId ?? computers[0]?.id ?? "" });
    setPorts(live ? structuredClone(live.ports) : []);
    setBundlePreview(undefined);
    setBundleNotice(undefined);
    // Image uploads refresh `live`; they must not discard ports the user is midway through typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server?.serverId, computerId]);

  const importBundle = useMutation({
    mutationFn: async () => {
      const preview = await window.testforge.devices.previewBundle("hardware");
      if (preview && server && preview.hardware.hardwareId !== server.hardwareId) {
        throw new Error(`当前 Server 绑定的是 ${server.hardwareId}，不能导入 ${preview.hardware.hardwareId}`);
      }
      return preview;
    },
    onSuccess: (preview) => {
      if (!preview) return;
      setBundlePreview(preview);
      setBundleNotice(`已载入 ${preview.hardware.label}；保存 Server 后才会写入并绑定`);
      setForm((current) => ({ ...current, hardwareId: preview.hardware.hardwareId, label: preview.hardware.label }));
      setPorts(structuredClone(preview.hardware.ports));
    },
    onError: () => setBundleNotice(undefined)
  });
  const exportBundle = useMutation({
    mutationFn: async () => await window.testforge.devices.exportBundle("hardware", form.hardwareId.trim()),
    onSuccess: (result) => { if (result) setBundleNotice(`已导出到 ${result.path}`); },
    onError: () => setBundleNotice(undefined)
  });
  const save = useMutation({
    mutationFn: async () => {
      const host = computers.find((item) => item.id === form.computerId)?.address ?? "";
      const hardwareId = form.hardwareId.trim();
      const input: McpServerConfig = {
        transport: "mcp-http",
        serverId: form.serverId.trim(),
        computerId: form.computerId,
        label: form.label.trim() || form.serverId.trim(),
        hardwareId,
        url: form.url.trim() || `http://${host}:8011/mcp`,
        enabled: true,
        lifecycle: {
          statusCommand: form.statusCommand.trim(),
          startCommand: form.startCommand.trim(),
          stopCommand: form.stopCommand.trim(),
          logPath: form.logPath.trim()
        }
      };
      const saved = await window.testforge.devices.saveServer(input, form.mcpToken ? { mcpToken: form.mcpToken } : undefined);
      if (bundlePreview) {
        await window.testforge.devices.applyBundle({ kind: "hardware", hardwareId, serverId: input.serverId, data: bundlePreview.data });
      }
      await window.testforge.devices.saveHardware({
        formatVersion: 2,
        hardwareId,
        label: input.label,
        kind: "managed",
        serverId: input.serverId,
        computerId: input.computerId,
        ports,
        ...(bundlePreview?.hardware.appearanceAssetId || selectedHardware?.appearanceAssetId
          ? { appearanceAssetId: bundlePreview?.hardware.appearanceAssetId ?? selectedHardware?.appearanceAssetId }
          : {})
      });
      return saved;
    },
    onSuccess: async () => { await onChanged(); onClose(); }
  });

  const field = (key: keyof typeof form) => ({
    value: String(form[key]),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [key]: event.target.value }))
  });
  const pathField = (key: "statusCommand" | "startCommand" | "stopCommand" | "logPath") => ({
    value: form[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setPathsTouched(true);
      setForm((current) => ({ ...current, [key]: event.target.value }));
    }
  });

  return <Modal
    open={open}
    onClose={onClose}
    title={server ? "编辑 MCP Server" : "添加 MCP Server"}
    width={760}
    footer={<>
      <div className="bundle-actions">
        <Btn variant="subtle" icon={<IconDownload size={14} />} disabled={save.isPending || importBundle.isPending || exportBundle.isPending} onClick={() => importBundle.mutate()}>导入</Btn>
        <Btn variant="subtle" icon={<IconCopy size={14} />} disabled={!selectedHardware || save.isPending || importBundle.isPending || exportBundle.isPending} title={selectedHardware ? "导出这台 MCP Server 的硬件定义" : "保存 Server 后才能导出"} onClick={() => exportBundle.mutate()}>导出</Btn>
        {bundleNotice && <span className="library-notice" role="status">{bundleNotice}</span>}
        {(importBundle.isError || exportBundle.isError) && <span className="library-notice error" role="alert" title={errorMessage(importBundle.error ?? exportBundle.error)}><IconAlert size={14} />{errorMessage(importBundle.error ?? exportBundle.error)}</span>}
      </div>
      <Btn onClick={onClose}>取消</Btn>
      <Btn variant="primary" onClick={() => save.mutate()} disabled={save.isPending || !form.serverId || !form.computerId || !form.hardwareId}>{save.isPending ? "保存中…" : "保存"}</Btn>
    </>}
  >
    <div className="form-grid">
      <EditorField label="Server ID" required><input className="input" value={form.serverId} disabled={Boolean(server)} onChange={(event) => { const serverId = event.target.value; setForm((current) => ({ ...current, serverId, ...(pathsTouched ? {} : serverDefaults(serverId)) })); }} placeholder="PCI1710L_MCP" /></EditorField>
      <EditorField label="所属电脑" required><select className="input" {...field("computerId")} disabled={Boolean(server)}>{computers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></EditorField>
      <EditorField label="显示名称"><input className="input" {...field("label")} placeholder="PCI-1710L 多功能采集卡" /></EditorField>
      <EditorField label="唯一 Hardware ID" required>
        <input className="input" list="testforge-hardware-ids" value={form.hardwareId} disabled={Boolean(server)} placeholder="PC1_MCP.PCI1710L_CARD_0" onChange={(event) => {
          const hardwareId = event.target.value;
          const selected = hardware.find((item) => item.hardwareId === hardwareId);
          setForm((current) => ({ ...current, hardwareId }));
          setBundlePreview(undefined);
          setBundleNotice(undefined);
          if (selected) setPorts(structuredClone(selected.ports));
        }} />
        <datalist id="testforge-hardware-ids">{hardware.filter((item) => item.kind === "passive" || item.serverId === server?.serverId).map((item) => <option key={item.hardwareId} value={item.hardwareId}>{item.label}</option>)}</datalist>
      </EditorField>
      <EditorField label="MCP 地址"><input className="input" {...field("url")} placeholder="http://192.168.3.51:8011/mcp" /></EditorField>
      <EditorField label={server ? "MCP Token（留空保持不变）" : "MCP Token"}><input className="input" type="password" {...field("mcpToken")} /></EditorField>
      <div className="span-2 form-note">可直接在这里导入 `.tfhw`；TestForge 会在保存 Server 时绑定硬件，并验证 list_hardware 恰好返回这一块硬件。端口和针脚不再向远端索取。</div>
      <EditorField label="状态查询命令" required span><textarea className="input" {...pathField("statusCommand")} /></EditorField>
      <EditorField label="启动命令" required span><textarea className="input" {...pathField("startCommand")} /></EditorField>
      <EditorField label="停止命令" required span><textarea className="input" {...pathField("stopCommand")} /></EditorField>
      <EditorField label="日志目录" required span><input className="input" {...pathField("logPath")} /></EditorField>
      <div className="span-2 editor-assets">
        <AppearanceImage hardwareId={form.hardwareId} assetId={selectedHardware?.appearanceAssetId} saved={Boolean(selectedHardware)} onChanged={(item) => setPorts(structuredClone(item.ports))} />
        <PortEditor hardwareId={form.hardwareId} ports={ports} saved={Boolean(selectedHardware)} onChange={setPorts} onImageChanged={(item) => setPorts(structuredClone(item.ports))} />
      </div>
      {save.isError && <div className="alert span-2"><IconAlert size={15} /><span>{errorMessage(save.error)}</span></div>}
    </div>
  </Modal>;
}
