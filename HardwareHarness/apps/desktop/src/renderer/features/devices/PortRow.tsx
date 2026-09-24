import type { HardwarePort } from "@hardwareharness/contracts/devices";
import { ChevronRightIcon, ImageIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Badge, Button, cn, IconButton, Input } from "../../ui";
import { HardwareImage } from "./HardwareImage.js";
import { addPin, removePin, renamePort, updatePin, withoutImage } from "./port-model.js";

/** One port: id/name row with its photo, and (expanded) its pin list. */
export function PortRow({ hardwareId, port, saved, open, imageBusy, onToggle, onChange, onRemove, onImage }: {
  hardwareId: string;
  port: HardwarePort;
  saved: boolean;
  open: boolean;
  imageBusy: boolean;
  onToggle: () => void;
  onChange: (port: HardwarePort) => void;
  onRemove: () => void;
  onImage: (action: "import" | "remove") => void;
}) {
  return (
    <article className={cn("rounded-md border border-line bg-surface-1", open && "border-line-strong")}>
      <div className="flex flex-wrap items-center gap-2 px-1.5 py-1">
        <button
          type="button"
          className="grid size-5 flex-none place-items-center rounded-sm text-fg-3 outline-none hover:text-fg"
          aria-label={open ? `收起 ${port.name}` : `展开 ${port.name}`}
          aria-expanded={open}
          onClick={onToggle}
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform duration-120", open && "rotate-90")} />
        </button>
        <Input
          className="h-6 w-24 flex-none font-mono text-xs"
          value={port.portId}
          aria-label="端口 ID"
          onChange={(event) => onChange(renamePort(port, event.target.value))}
        />
        <Input
          className="h-6 min-w-[100px] flex-1 basis-[120px] text-xs"
          value={port.name}
          aria-label="端口名称"
          placeholder="端口名称"
          onChange={(event) => onChange({ ...port, name: event.target.value })}
        />
        <Badge mono>{port.pins.length ? `${port.pins.length} 针` : "无针脚"}</Badge>
        {saved && port.imageAssetId && (
          <HardwareImage
            hardwareId={hardwareId}
            assetId={port.imageAssetId}
            alt={`${port.name} 端口图`}
            className="size-10 rounded-sm border border-line object-cover"
          />
        )}
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            disabled={!saved || imageBusy}
            title={saved ? "上传或更换该端口的照片" : "保存设备后可上传端口图"}
            onClick={() => onImage("import")}
          >
            <ImageIcon />{port.imageAssetId ? "更换" : "端口图"}
          </Button>
          {port.imageAssetId && (
            <Button
              variant="ghost"
              size="xs"
              disabled={imageBusy}
              onClick={() => (saved ? onImage("remove") : onChange(withoutImage(port)))}
            >
              移除图
            </Button>
          )}
        </span>
        <IconButton label={`删除端口 ${port.name}`} size="icon-sm" onClick={onRemove}><Trash2Icon /></IconButton>
      </div>
      {open && (
        <div className="grid gap-1 border-t border-line bg-surface-0/60 py-1.5 pr-1.5 pl-[30px]">
          {port.pins.map((pin) => (
            <div className="grid grid-cols-[24px_96px_minmax(0,1fr)_24px] items-center gap-2" key={pin.pinId}>
              <span className="tf-num text-right text-2xs text-fg-3">{pin.position}</span>
              <Input
                className="h-6 font-mono text-xs"
                value={pin.pinId}
                aria-label="针脚 ID"
                onChange={(event) => onChange(updatePin(port, pin.pinId, { pinId: event.target.value }))}
              />
              <Input
                className="h-6 text-xs"
                value={pin.label}
                aria-label="针脚信号"
                placeholder="信号名称，可留空"
                onChange={(event) => onChange(updatePin(port, pin.pinId, { label: event.target.value }))}
              />
              <IconButton
                label={`删除针脚 ${pin.pinId}`}
                size="icon-sm"
                onClick={() => onChange(removePin(port, pin.pinId))}
              >
                <Trash2Icon />
              </IconButton>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-0.5">
            <Button variant="ghost" size="xs" onClick={() => onChange(addPin(port))}><PlusIcon />添加针脚</Button>
            {port.pins.length === 0 && (
              <span className="text-xs text-fg-3">没有针脚也可以保存，接线时按整个端口连接。</span>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
