import { useEffect, useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import type {
  DeviceBundlePreview, Hardware, HardwarePort, McpServerConfig, RemoteComputer
} from "@hardwareharness/contracts/devices";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { errorMessage } from "../../../../lib/errors.js";
import { hardwareForServer } from "../../../../lib/hardware.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Input, Select, Textarea } from "../../../../ui";
import { AppearanceImage, PortEditor } from "../../PortEditor.js";
import { BundleActions } from "../BundleActions.js";
import { EditorAlert, EditorField, EditorNote, EditorPanel, editorGrid } from "./EditorField.js";

const required = (message: string) => z.string().trim().min(1, message);
const serverEditorSchema = z.object({
  serverId: required("请输入 Server ID"),
  computerId: required("请选择所属电脑"),
  label: z.string(),
  hardwareId: required("请输入 Hardware ID"),
  url: z.string(),
  mcpToken: z.string(),
  statusCommand: required("请输入状态查询命令"),
  startCommand: required("请输入启动命令"),
  stopCommand: required("请输入停止命令"),
  logPath: required("请输入日志目录")
});
type ServerEditorValues = z.infer<typeof serverEditorSchema>;
type LifecycleKey = "statusCommand" | "startCommand" | "stopCommand" | "logPath";

/** Lifecycle scripts follow the `E:\<name>_mcp_server` layout of the reference MCP servers. */
export function serverDefaults(serverId: string): Pick<ServerEditorValues, LifecycleKey> {
  const hardwareName = serverId.replace(/_MCP$/, "").toLowerCase();
  const root = `E:\\${hardwareName}_mcp_server`;
  return {
    statusCommand: `& '${root}\\status.ps1'`,
    startCommand: `& '${root}\\start.ps1'`,
    stopCommand: `& '${root}\\stop.ps1'`,
    logPath: `${root}\\logs`
  };
}

function initialValues(server: McpServerConfig | undefined, computerId: string): ServerEditorValues {
  if (server) {
    return {
      serverId: server.serverId,
      computerId: server.computerId,
      label: server.label,
      hardwareId: server.hardwareId,
      url: server.url,
      mcpToken: "",
      ...server.lifecycle
    };
  }
  return { serverId: "", computerId, label: "", hardwareId: "", url: "", mcpToken: "", ...serverDefaults("") };
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
  const defaultComputer = computerId ?? computers[0]?.id ?? "";
  const { register, reset, watch, setValue, handleSubmit, formState } = useForm<ServerEditorValues>({
    resolver: zodResolver(serverEditorSchema),
    mode: "onChange",
    defaultValues: initialValues(undefined, defaultComputer)
  });
  const { errors, isValid } = formState;
  const [ports, setPorts] = useState<HardwarePort[]>([]);
  const [bundlePreview, setBundlePreview] = useState<DeviceBundlePreview>();
  // Bumped to clear the bundle notice when the hardware binding changes by hand.
  const [bundleKey, setBundleKey] = useState(0);
  // Typing a Server ID autofills the lifecycle paths until the user edits one of them.
  const pathsTouched = useRef(false);
  const hardwareId = watch("hardwareId");
  const live = server ? hardwareForServer(server, hardware) : undefined;
  const selectedHardware = live ?? hardware.find((item) => item.hardwareId === hardwareId);

  useEffect(() => {
    if (!open) return;
    reset(initialValues(server, defaultComputer));
    pathsTouched.current = Boolean(server);
    setPorts(live ? structuredClone(live.ports) : []);
    setBundlePreview(undefined);
    setBundleKey((key) => key + 1);
    // Image uploads refresh `live`; they must not discard ports the user is midway through typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server?.serverId, computerId]);

  const lifecycleKeys: LifecycleKey[] = ["statusCommand", "startCommand", "stopCommand", "logPath"];
  const lifecycleField = (key: LifecycleKey) => register(key, { onChange: () => { pathsTouched.current = true; } });
  const serverIdField = register("serverId", {
    onChange: (event: { target: { value: string } }) => {
      if (pathsTouched.current) return;
      const defaults = serverDefaults(event.target.value);
      for (const key of lifecycleKeys) setValue(key, defaults[key], { shouldValidate: true });
    }
  });
  const hardwareIdField = register("hardwareId", {
    onChange: (event: { target: { value: string } }) => {
      const known = hardware.find((item) => item.hardwareId === event.target.value);
      setBundlePreview(undefined);
      setBundleKey((key) => key + 1);
      if (known) setPorts(structuredClone(known.ports));
    }
  });

  const stagePreview = (preview: DeviceBundlePreview) => {
    if (server && preview.hardware.hardwareId !== server.hardwareId) {
      throw new Error(`当前 Server 绑定的是 ${server.hardwareId}，不能导入 ${preview.hardware.hardwareId}`);
    }
    setBundlePreview(preview);
    setValue("hardwareId", preview.hardware.hardwareId, { shouldValidate: true });
    setValue("label", preview.hardware.label, { shouldValidate: true });
    setPorts(structuredClone(preview.hardware.ports));
    return `已载入 ${preview.hardware.label}；保存 Server 后才会写入并绑定`;
  };

  const save = useMutation({
    mutationFn: async (values: ServerEditorValues) => {
      const devices = window.hardwareharness.devices;
      const host = computers.find((item) => item.id === values.computerId)?.address ?? "";
      const serverId = values.serverId.trim();
      const boundId = values.hardwareId.trim();
      const input: McpServerConfig = {
        transport: "mcp-http",
        serverId,
        computerId: values.computerId,
        label: values.label.trim() || serverId,
        hardwareId: boundId,
        url: values.url.trim() || `http://${host}:8011/mcp`,
        enabled: true,
        lifecycle: {
          statusCommand: values.statusCommand.trim(),
          startCommand: values.startCommand.trim(),
          stopCommand: values.stopCommand.trim(),
          logPath: values.logPath.trim()
        }
      };
      const saved = await devices.saveServer(input, values.mcpToken ? { mcpToken: values.mcpToken } : undefined);
      if (bundlePreview) {
        await devices.applyBundle({ kind: "hardware", hardwareId: boundId, serverId, data: bundlePreview.data });
      }
      const appearanceAssetId = bundlePreview?.hardware.appearanceAssetId ?? selectedHardware?.appearanceAssetId;
      await devices.saveHardware({
        formatVersion: 2,
        hardwareId: boundId,
        label: input.label,
        kind: "managed",
        serverId,
        computerId: input.computerId,
        ports,
        ...(appearanceAssetId ? { appearanceAssetId } : {})
      });
      return saved;
    },
    onSuccess: async () => { await onChanged(); onClose(); }
  });
  const submit = handleSubmit(async (values) => { await save.mutateAsync(values); });
  const syncPorts = (item: Hardware) => setPorts(structuredClone(item.ports));
  const bindable = hardware.filter((item) => item.kind === "passive" || item.serverId === server?.serverId);
  const commandClass = "min-h-[54px] font-mono text-xs";

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent title={server ? "编辑 MCP Server" : "添加 MCP Server"} size="lg" className="w-[760px]">
        <DialogBody>
          <form id="server-editor-form" className={editorGrid} onSubmit={(event) => { void submit(event); }}>
            <EditorField label="Server ID" required error={errors.serverId?.message}>
              <Input className="font-mono" {...serverIdField} disabled={Boolean(server)} placeholder="PCI1710L_MCP" />
            </EditorField>
            <EditorField label="所属电脑" required error={errors.computerId?.message}>
              <Select {...register("computerId")} disabled={Boolean(server)}>
                {computers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </Select>
            </EditorField>
            <EditorField label="显示名称">
              <Input {...register("label")} placeholder="PCI-1710L 多功能采集卡" />
            </EditorField>
            <EditorField label="唯一 Hardware ID" required error={errors.hardwareId?.message}>
              <Input
                className="font-mono"
                list="hardwareharness-hardware-ids"
                {...hardwareIdField}
                disabled={Boolean(server)}
                placeholder="PC1_MCP.PCI1710L_CARD_0"
              />
            </EditorField>
            <datalist id="hardwareharness-hardware-ids">
              {bindable.map((item) => <option key={item.hardwareId} value={item.hardwareId}>{item.label}</option>)}
            </datalist>
            <EditorField label="MCP 地址">
              <Input className="font-mono" {...register("url")} placeholder="http://192.168.3.51:8011/mcp" />
            </EditorField>
            <EditorField label={server ? "MCP Token（留空保持不变）" : "MCP Token"}>
              <Input type="password" {...register("mcpToken")} />
            </EditorField>
            <EditorNote>
              可直接在这里导入 `.hhhw`；HardwareHarness 会在保存 Server 时绑定硬件，并验证 list_hardware
              恰好返回这一块硬件。端口和针脚不再向远端索取。
            </EditorNote>
            <EditorField label="状态查询命令" required span error={errors.statusCommand?.message}>
              <Textarea className={commandClass} {...lifecycleField("statusCommand")} />
            </EditorField>
            <EditorField label="启动命令" required span error={errors.startCommand?.message}>
              <Textarea className={commandClass} {...lifecycleField("startCommand")} />
            </EditorField>
            <EditorField label="停止命令" required span error={errors.stopCommand?.message}>
              <Textarea className={commandClass} {...lifecycleField("stopCommand")} />
            </EditorField>
            <EditorField label="日志目录" required span error={errors.logPath?.message}>
              <Input className="font-mono text-xs" {...lifecycleField("logPath")} />
            </EditorField>
            <EditorPanel>
              <AppearanceImage
                hardwareId={hardwareId}
                assetId={selectedHardware?.appearanceAssetId}
                saved={Boolean(selectedHardware)}
                onChanged={syncPorts}
              />
              <PortEditor
                hardwareId={hardwareId}
                ports={ports}
                saved={Boolean(selectedHardware)}
                onChange={setPorts}
                onImageChanged={syncPorts}
              />
            </EditorPanel>
            {save.isError && <EditorAlert message={errorMessage(save.error)} />}
          </form>
        </DialogBody>
        <DialogFooter>
          <BundleActions
            key={bundleKey}
            kind="hardware"
            id={hardwareId}
            saved={Boolean(selectedHardware)}
            disabled={save.isPending}
            exportTitle="导出这台 MCP Server 的硬件定义"
            onPreview={stagePreview}
          />
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" form="server-editor-form" disabled={save.isPending || !isValid}>
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
