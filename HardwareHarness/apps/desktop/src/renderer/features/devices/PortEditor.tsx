import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Hardware, HardwarePort } from "@hardwareharness/contracts/devices";
import { ChevronRightIcon, CircleAlertIcon, ImageIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { cn } from "../../shared/ui/cn";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Input } from "../../shared/ui/input";
import { HardwareImage } from "./HardwareImage.js";

/**
 * Two-level editor for a device's ports and their pins.
 *
 * Ports are a list, pins are a nested list under each port, and the port photo sits on the
 * port's own row — a port, its pins and its picture are one thing to the operator, so they are one
 * thing here too. A port with no pins is a normal state, not an error: a fibre or coax connector is
 * wired as a whole.
 */
export function PortEditor({ hardwareId, ports, saved, onChange, onImageChanged }: {
  hardwareId: string;
  ports: HardwarePort[];
  /** False while the device has never been saved: images need a record on disk to attach to. */
  saved: boolean;
  onChange: (ports: HardwarePort[]) => void;
  onImageChanged: (hardware: Hardware) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string>();

  const image = useMutation({
    mutationFn: async ({ action, portId }: { action: "import" | "remove"; portId?: string }) => {
      const target = { hardwareId, ...(portId === undefined ? {} : { portId }) };
      return action === "import" ? await window.hardwareharness.devices.importHardwareImage(target) : await window.hardwareharness.devices.removeHardwareImage(target);
    },
    onSuccess: (hardware) => { setError(undefined); if (hardware) onImageChanged(hardware); },
    onError: (value) => setError(String(value))
  });

  const update = (portId: string, change: (port: HardwarePort) => HardwarePort) =>
    onChange(ports.map((port) => port.portId === portId ? change(port) : port));

  const addPort = () => {
    const portId = uniqueId("J", new Set(ports.map((item) => item.portId)));
    onChange([...ports, { portId, name: portId, pins: [] }]);
    setExpanded((current) => ({ ...current, [portId]: true }));
  };

  const renamePort = (port: HardwarePort, portId: string) => {
    // The image lives at a path derived from portId, so a rename would orphan it. Dropping the
    // reference is honest: the picture no longer belongs to a port that exists.
    const { imageAssetId: _dropped, ...rest } = port;
    onChange(ports.map((item) => item.portId === port.portId ? { ...(port.imageAssetId ? rest : port), portId } : item));
  };

  return (
    <div className="grid gap-2.5">
      <div className="flex items-center gap-2.5">
        <strong className="text-xs font-semibold">端口与针脚</strong>
        <span className="text-xs text-muted-foreground">{ports.length} 个端口 · {ports.reduce((total, port) => total + port.pins.length, 0)} 个针脚</span>
        <Button variant="outline" size="xs" className="ml-auto" onClick={addPort}><PlusIcon />添加端口</Button>
      </div>
      {!saved && <p className="m-0 text-xs leading-relaxed text-muted-foreground">先保存设备，再上传外观图和端口图。</p>}
      {error && <div className="flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/6 px-3.5 py-2.5 text-xs break-words whitespace-pre-wrap text-destructive [&_svg]:mt-0.5 [&_svg]:flex-none"><CircleAlertIcon className="size-4" /><span>{error}</span></div>}

      <div className="grid max-h-[340px] content-start gap-1.5 overflow-y-auto pr-1">
        {ports.map((port) => {
          const open = expanded[port.portId] ?? false;
          return (
            <article className={cn("rounded-xl bg-card shadow-sm ring-1 ring-border", open && "ring-foreground/20")} key={port.portId}>
              <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                <button
                  type="button"
                  className="grid flex-none cursor-pointer place-items-center border-0 bg-none p-0 text-muted-foreground/60"
                  aria-label={open ? `收起 ${port.name}` : `展开 ${port.name}`}
                  aria-expanded={open}
                  onClick={() => setExpanded((current) => ({ ...current, [port.portId]: !open }))}
                >
                  <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
                </button>
                <Input
                  className="h-7 w-24 flex-none px-2 text-xs"
                  value={port.portId}
                  aria-label="端口 ID"
                  onChange={(event) => renamePort(port, event.target.value)}
                />
                <Input
                  className="h-7 min-w-[100px] flex-1 basis-[120px] px-2 text-xs"
                  value={port.name}
                  aria-label="端口名称"
                  placeholder="端口名称"
                  onChange={(event) => update(port.portId, (item) => ({ ...item, name: event.target.value }))}
                />
                <Badge variant={port.pins.length ? "secondary" : "default"}>{port.pins.length ? `${port.pins.length} 针` : "无针脚"}</Badge>
                {saved && port.imageAssetId && (
                  <HardwareImage hardwareId={hardwareId} assetId={port.imageAssetId} alt={`${port.name} 端口图`} className="h-10 w-10 rounded-md object-cover" />
                )}
                <span className="ml-auto flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={!saved || image.isPending}
                    title={saved ? "上传或更换该端口的照片" : "保存设备后可上传端口图"}
                    onClick={() => image.mutate({ action: "import", portId: port.portId })}
                  ><ImageIcon />{port.imageAssetId ? "更换" : "端口图"}</Button>
                  {port.imageAssetId && (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={image.isPending}
                      onClick={() => {
                        if (saved) image.mutate({ action: "remove", portId: port.portId });
                        else update(port.portId, (item) => { const { imageAssetId: _removed, ...rest } = item; return rest; });
                      }}
                    >移除图</Button>
                  )}
                </span>
                <button
                  type="button"
                  className="grid size-6 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
                  title={`删除端口 ${port.name}`}
                  aria-label={`删除端口 ${port.name}`}
                  onClick={() => onChange(ports.filter((item) => item.portId !== port.portId))}
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </div>
              {open && (
                <div className="grid gap-1 bg-secondary/30 pt-1 pr-2 pb-2 pl-[30px]">
                  {port.pins.map((pin) => (
                    <div className="grid grid-cols-[24px_96px_minmax(0,1fr)_28px] items-center gap-2" key={pin.pinId}>
                      <span className="text-right text-[11px] text-muted-foreground/70">{pin.position}</span>
                      <Input
                        className="h-7 px-2 text-xs"
                        value={pin.pinId}
                        aria-label="针脚 ID"
                        onChange={(event) => update(port.portId, (item) => ({
                          ...item,
                          pins: item.pins.map((entry) => entry.pinId === pin.pinId ? { ...entry, pinId: event.target.value } : entry)
                        }))}
                      />
                      <Input
                        className="h-7 px-2 text-xs"
                        value={pin.label}
                        aria-label="针脚信号"
                        placeholder="信号名称，可留空"
                        onChange={(event) => update(port.portId, (item) => ({
                          ...item,
                          pins: item.pins.map((entry) => entry.pinId === pin.pinId ? { ...entry, label: event.target.value } : entry)
                        }))}
                      />
                      <button
                        type="button"
                        className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
                        title={`删除针脚 ${pin.pinId}`}
                        aria-label={`删除针脚 ${pin.pinId}`}
                        onClick={() => update(port.portId, (item) => ({ ...item, pins: renumber(item.pins.filter((entry) => entry.pinId !== pin.pinId)) }))}
                      >
                        <Trash2Icon className="size-3.5" />
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => update(port.portId, (item) => ({
                        ...item,
                        pins: [...item.pins, { pinId: uniqueId("", new Set(item.pins.map((entry) => entry.pinId))), position: item.pins.length + 1, label: "" }]
                      }))}
                    ><PlusIcon />添加针脚</Button>
                    {port.pins.length === 0 && <span className="text-xs text-muted-foreground">没有针脚也可以保存，接线时按整个端口连接。</span>}
                  </div>
                </div>
              )}
            </article>
          );
        })}
        {!ports.length && <div className="px-2 py-4 text-center text-xs text-muted-foreground">还没有端口。点「添加端口」登记这台设备的接口。</div>}
      </div>
    </div>
  );
}

/** Appearance photo of the device as a whole; port photos are handled inside {@link PortEditor}. */
export function AppearanceImage({ hardwareId, assetId, saved, onChanged }: {
  hardwareId: string;
  assetId?: string | undefined;
  saved: boolean;
  onChanged: (hardware: Hardware) => void;
}) {
  const [error, setError] = useState<string>();
  const image = useMutation({
    mutationFn: async (action: "import" | "remove") =>
      action === "import" ? await window.hardwareharness.devices.importHardwareImage({ hardwareId }) : await window.hardwareharness.devices.removeHardwareImage({ hardwareId }),
    onSuccess: (hardware) => { setError(undefined); if (hardware) onChanged(hardware); },
    onError: (value) => setError(String(value))
  });
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-2">
      <span className="w-12 flex-none text-xs font-semibold text-muted-foreground">外观图</span>
      {assetId
        ? <HardwareImage hardwareId={hardwareId} assetId={assetId} alt="外观图" className="h-16 max-h-16 rounded-md" />
        : <span className="min-w-11 flex-none text-xs text-muted-foreground/70">未上传</span>}
      <Button variant="ghost" size="xs" disabled={!saved || image.isPending} onClick={() => image.mutate("import")}>
        <ImageIcon />{assetId ? "更换" : "上传"}
      </Button>
      {assetId && <Button variant="ghost" size="xs" disabled={image.isPending} onClick={() => image.mutate("remove")}>移除</Button>}
      {error && <div className="flex w-full items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/6 px-3.5 py-2.5 text-xs break-words whitespace-pre-wrap text-destructive [&_svg]:mt-0.5 [&_svg]:flex-none"><CircleAlertIcon className="size-4" /><span>{error}</span></div>}
    </div>
  );
}

/** Ports and pins are identified by hand-typed ids, so a new row only needs a free default. */
function uniqueId(prefix: string, taken: Set<string>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `${prefix}${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Positions describe physical order, so they stay contiguous when a pin in the middle goes. */
function renumber(pins: HardwarePort["pins"]): HardwarePort["pins"] {
  return pins.map((pin, index) => ({ ...pin, position: index + 1 }));
}
