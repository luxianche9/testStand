import { useEffect, useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import type {
  DeviceBundlePreview, Hardware, HardwarePort, McpHttpServerConfig, RemoteComputer, ServerLifecycle
} from "@hardwareharness/contracts/devices";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { errorMessage } from "../../../../lib/errors.js";
import { hardwareForServer } from "../../../../lib/hardware.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, Input, Select, Textarea } from "../../../../ui";
import { PortEditor } from "../../PortEditor.js";
import { BundleActions } from "../BundleActions.js";
import { EditorAlert, EditorField, EditorNote, EditorPanel, editorGrid } from "./EditorField.js";

const required = (message: string) => z.string().trim().min(1, message);
const serverEditorSchema = z.object({
  serverId: required("请输入 Server ID"),
  // Empty: an unmanaged service that is only used over its URL (design doc §4.8.3).
  computerId: z.string(),
  label: z.string(),
  hardwareId: required("请输入 Hardware ID"),
  url: z.string(),
  mcpToken: z.string(),
  root: z.string(),
  statusCommand: z.string(),
  startCommand: z.string(),
  stopCommand: z.string(),
  forceStopCommand: z.string(),
  logPath: z.string()
}).refine((value) => !value.computerId || value.root.trim() || value.statusCommand.trim(), {
  path: ["root"],
  message: "托管的服务需要安装目录（或在高级选项里填写状态查询命令）"
});
type ServerEditorValues = z.infer<typeof serverEditorSchema>;
type LifecycleKey = keyof ServerLifecycle;
const lifecycleFields: { key: LifecycleKey; label: string }[] = [
  { key: "statusCommand", label: "状态查询命令" },
  { key: "startCommand", label: "启动命令" },
  { key: "stopCommand", label: "停止命令" },
  { key: "forceStopCommand", label: "强制停止命令" },
  { key: "logPath", label: "日志目录" }
];

/** Bundles install to `E:\<name>_mcp_server`; start/stop/status/logs derive from it (§4.8.2). */
function defaultRoot(serverId: string): string {
  return `E:\\${serverId.replace(/_MCP$/, "").toLowerCase()}_mcp_server`;
}

function initialValues(server: McpHttpServerConfig | undefined, computerId: string): ServerEditorValues {
  const overrides: Record<LifecycleKey, string> = {
    statusCommand: server?.lifecycle?.statusCommand ?? "",
    startCommand: server?.lifecycle?.startCommand ?? "",
    stopCommand: server?.lifecycle?.stopCommand ?? "",
    forceStopCommand: server?.lifecycle?.forceStopCommand ?? "",
    logPath: server?.lifecycle?.logPath ?? ""
  };
  if (server) {
    return {
      serverId: server.serverId,
      computerId: server.computerId ?? "",
      label: server.label,
      hardwareId: server.hardwareId,
      url: server.url,
      mcpToken: "",
      root: server.root ?? "",
      ...overrides
    };
  }
  return {
    serverId: "", computerId, label: "", hardwareId: "", url: "", mcpToken: "", root: defaultRoot(""), ...overrides
  };
}

/** A server and the single managed hardware device it drives are edited together. */
export function ServerEditor({ open, server, computerId, computers, hardware, onClose, onChanged }: {
  open: boolean;
  server?: McpHttpServerConfig | undefined;
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
  // Typing a Server ID autofills the install root until the user edits it.
  const rootTouched = useRef(false);
  const hardwareId = watch("hardwareId");
  const live = server ? hardwareForServer(server, hardware) : undefined;
  const selectedHardware = live ?? hardware.find((item) => item.hardwareId === hardwareId);

  useEffect(() => {
    if (!open) return;
    reset(initialValues(server, defaultComputer));
    rootTouched.current = Boolean(server);
    setPorts(live ? structuredClone(live.ports) : []);
    setBundlePreview(undefined);
    setBundleKey((key) => key + 1);
    // Catalog refetches refresh `live`; they must not discard ports the user is midway through typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server?.serverId, computerId]);

  const rootField = register("root", { onChange: () => { rootTouched.current = true; } });
  const serverIdField = register("serverId", {
    onChange: (event: { target: { value: string } }) => {
      if (!rootTouched.current) setValue("root", defaultRoot(event.target.value), { shouldValidate: true });
    }
  });
  const managed = Boolean(watch("computerId"));
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
      const root = values.root.trim();
      const lifecycle: ServerLifecycle = Object.fromEntries(
        lifecycleFields.flatMap(({ key }) => (values[key].trim() ? [[key, values[key].trim()]] : []))
      );
      const input: McpHttpServerConfig = {
        transport: "mcp-http",
        serverId,
        ...(values.computerId ? { computerId: values.computerId } : {}),
        label: values.label.trim() || serverId,
        hardwareId: boundId,
        url: values.url.trim() || `http://${host}:8011/mcp`,
        enabled: true,
        ...(values.computerId && root ? { root } : {}),
        ...(values.computerId && Object.keys(lifecycle).length ? { lifecycle } : {})
      };
      const saved = await devices.saveServer(input, values.mcpToken ? { mcpToken: values.mcpToken } : undefined);
      if (bundlePreview) {
        await devices.applyBundle({ kind: "hardware", hardwareId: boundId, serverId, data: bundlePreview.data });
      }
      await devices.saveHardware({
        formatVersion: 2,
        hardwareId: boundId,
        label: input.label,
        kind: "managed",
        serverId,
        ...(input.computerId ? { computerId: input.computerId } : {}),
        ports
      });
      return saved;
    },
    onSuccess: async () => { await onChanged(); onClose(); }
  });
  const submit = handleSubmit(async (values) => { await save.mutateAsync(values); });
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
            <EditorField label="所属电脑" error={errors.computerId?.message}>
              <Select {...register("computerId")} disabled={Boolean(server)}>
                <option value="">无（未托管，只通过 URL 使用）</option>
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
            {managed && (
              <>
                <EditorField label="安装目录" span error={errors.root?.message}>
                  <Input className="font-mono text-xs" {...rootField} placeholder="E:\pci1710l_mcp_server" />
                </EditorField>
                <details className="col-span-full text-xs">
                  <summary className="cursor-pointer text-fg-2">
                    高级：覆盖生命周期命令（只在非标准安装时填写，留空则由安装目录推导）
                  </summary>
                  <div className={`${editorGrid} mt-2`}>
                    {lifecycleFields.map(({ key, label }) => (
                      <EditorField key={key} label={label} span>
                        <Textarea className={commandClass} {...register(key)} />
                      </EditorField>
                    ))}
                  </div>
                </details>
              </>
            )}
            {!managed && <EditorNote>未托管的服务只能使用，不能从这里启动、停止或读取日志。</EditorNote>}
            <EditorPanel>
              <PortEditor ports={ports} onChange={setPorts} />
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
