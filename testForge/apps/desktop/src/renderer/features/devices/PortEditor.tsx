import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Hardware, HardwarePort } from "@testforge/contracts/devices";
import { IconAlert, IconChevron, IconImage, IconPlus, IconTrash } from "../../shared/icons.js";
import { Badge, Btn, Modal, Spinner } from "../../shared/ui.js";

/**
 * Two-level editor for a device's ports and their pins.
 *
 * Ports are a list, pins are a nested list under each port, and the port photo button sits on the
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
  const [preview, setPreview] = useState<{ title: string; assetId: string }>();
  const [error, setError] = useState<string>();

  const image = useMutation({
    mutationFn: async ({ action, portId }: { action: "import" | "remove"; portId?: string }) => {
      const target = { hardwareId, ...(portId === undefined ? {} : { portId }) };
      return action === "import" ? await window.testforge.devices.importHardwareImage(target) : await window.testforge.devices.removeHardwareImage(target);
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
    <div className="port-editor">
      <div className="port-editor-head">
        <strong>端口与针脚</strong>
        <span className="muted-copy">{ports.length} 个端口 · {ports.reduce((total, port) => total + port.pins.length, 0)} 个针脚</span>
        <Btn icon={<IconPlus size={14} />} onClick={addPort}>添加端口</Btn>
      </div>
      {!saved && <p className="form-note">先保存设备，再上传外观图和端口图。</p>}
      {error && <div className="alert"><IconAlert size={15} /><span>{error}</span></div>}

      <div className="port-list">
        {ports.map((port) => {
          const open = expanded[port.portId] ?? false;
          return (
            <article className={`port-item${open ? " open" : ""}`} key={port.portId}>
              <div className="port-row">
                <button
                  type="button"
                  className={`twisty${open ? " open" : ""}`}
                  aria-label={open ? `收起 ${port.name}` : `展开 ${port.name}`}
                  aria-expanded={open}
                  onClick={() => setExpanded((current) => ({ ...current, [port.portId]: !open }))}
                >
                  <IconChevron size={13} />
                </button>
                <input
                  className="input port-id-input"
                  value={port.portId}
                  aria-label="端口 ID"
                  onChange={(event) => renamePort(port, event.target.value)}
                />
                <input
                  className="input port-name-input"
                  value={port.name}
                  aria-label="端口名称"
                  placeholder="端口名称"
                  onChange={(event) => update(port.portId, (item) => ({ ...item, name: event.target.value }))}
                />
                <Badge tone={port.pins.length ? "muted" : "accent"}>{port.pins.length ? `${port.pins.length} 针` : "无针脚"}</Badge>
                <span className="port-image-actions">
                  {port.imageAssetId && (
                    <Btn variant="subtle" onClick={() => setPreview({ title: `${port.name} 端口图`, assetId: port.imageAssetId! })}>预览</Btn>
                  )}
                  <Btn
                    variant="subtle"
                    icon={<IconImage size={14} />}
                    disabled={!saved || image.isPending}
                    title={saved ? "上传或更换该端口的照片" : "保存设备后可上传端口图"}
                    onClick={() => image.mutate({ action: "import", portId: port.portId })}
                  >{port.imageAssetId ? "更换" : "端口图"}</Btn>
                  {port.imageAssetId && (
                    <Btn variant="subtle" disabled={image.isPending} onClick={() => image.mutate({ action: "remove", portId: port.portId })}>移除图</Btn>
                  )}
                </span>
                <button
                  type="button"
                  className="row-action"
                  title={`删除端口 ${port.name}`}
                  aria-label={`删除端口 ${port.name}`}
                  onClick={() => onChange(ports.filter((item) => item.portId !== port.portId))}
                >
                  <IconTrash size={14} />
                </button>
              </div>
              {open && (
                <div className="pin-list">
                  {port.pins.map((pin) => (
                    <div className="pin-row" key={pin.pinId}>
                      <span className="pin-position">{pin.position}</span>
                      <input
                        className="input pin-id-input"
                        value={pin.pinId}
                        aria-label="针脚 ID"
                        onChange={(event) => update(port.portId, (item) => ({
                          ...item,
                          pins: item.pins.map((entry) => entry.pinId === pin.pinId ? { ...entry, pinId: event.target.value } : entry)
                        }))}
                      />
                      <input
                        className="input pin-label-input"
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
                        className="row-action"
                        title={`删除针脚 ${pin.pinId}`}
                        aria-label={`删除针脚 ${pin.pinId}`}
                        onClick={() => update(port.portId, (item) => ({ ...item, pins: renumber(item.pins.filter((entry) => entry.pinId !== pin.pinId)) }))}
                      >
                        <IconTrash size={13} />
                      </button>
                    </div>
                  ))}
                  <div className="pin-row pin-add">
                    <Btn
                      variant="subtle"
                      icon={<IconPlus size={13} />}
                      onClick={() => update(port.portId, (item) => ({
                        ...item,
                        pins: [...item.pins, { pinId: uniqueId("", new Set(item.pins.map((entry) => entry.pinId))), position: item.pins.length + 1, label: "" }]
                      }))}
                    >添加针脚</Btn>
                    {port.pins.length === 0 && <span className="muted-copy">没有针脚也可以保存，接线时按整个端口连接。</span>}
                  </div>
                </div>
              )}
            </article>
          );
        })}
        {!ports.length && <div className="list-empty">还没有端口。点「添加端口」登记这台设备的接口。</div>}
      </div>

      <PortImageModal
        open={Boolean(preview)}
        title={preview?.title ?? ""}
        hardwareId={hardwareId}
        assetId={preview?.assetId}
        onClose={() => setPreview(undefined)}
      />
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
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string>();
  const image = useMutation({
    mutationFn: async (action: "import" | "remove") =>
      action === "import" ? await window.testforge.devices.importHardwareImage({ hardwareId }) : await window.testforge.devices.removeHardwareImage({ hardwareId }),
    onSuccess: (hardware) => { setError(undefined); if (hardware) onChanged(hardware); },
    onError: (value) => setError(String(value))
  });
  return (
    <div className="image-action-row">
      <span className="image-action-label">外观图</span>
      <span className="image-action-status">{assetId ? "已上传" : "未上传"}</span>
      {assetId && <Btn variant="subtle" onClick={() => setPreview(true)}>预览</Btn>}
      <Btn variant="subtle" icon={<IconImage size={14} />} disabled={!saved || image.isPending} onClick={() => image.mutate("import")}>
        {assetId ? "更换" : "上传"}
      </Btn>
      {assetId && <Btn variant="subtle" disabled={image.isPending} onClick={() => image.mutate("remove")}>移除</Btn>}
      {error && <div className="alert"><IconAlert size={15} /><span>{error}</span></div>}
      <PortImageModal open={preview} title="外观图" hardwareId={hardwareId} assetId={assetId} onClose={() => setPreview(false)} />
    </div>
  );
}

function PortImageModal({ open, title, hardwareId, assetId, onClose }: {
  open: boolean;
  title: string;
  hardwareId: string;
  assetId?: string | undefined;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} width={720} footer={<Btn variant="primary" onClick={onClose}>关闭</Btn>}>
      <div className="image-preview lightbox">
        {assetId ? <HardwareImage hardwareId={hardwareId} assetId={assetId} /> : <span className="muted-copy">无图片</span>}
      </div>
    </Modal>
  );
}

function HardwareImage({ hardwareId, assetId, alt = "" }: { hardwareId: string; assetId: string; alt?: string }) {
  const url = useQuery({
    queryKey: ["hardware-image", hardwareId, assetId],
    queryFn: () => window.testforge.devices.hardwareImageUrl(hardwareId, assetId),
    staleTime: Infinity
  });
  return url.data ? <img src={url.data} alt={alt} /> : <Spinner />;
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
