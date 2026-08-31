import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAui,
  useAuiState
} from "@assistant-ui/react";
import { AlertCircleIcon, FileTextIcon, Loader2Icon, XIcon } from "lucide-react";
import { useEffect, useState, type FC } from "react";
import { TooltipIconButton } from "../../shared/ui/index.js";
import { cn } from "../../shared/ui/index.js";

function useAttachmentPreview() {
  const type = useAuiState((state) => state.attachment.type);
  const file = useAuiState((state) => state.attachment.file);
  const remote = useAuiState((state) => {
    if (state.attachment.type !== "image") return undefined;
    return state.attachment.content?.find((part) => part.type === "image")?.image;
  });
  const [local, setLocal] = useState<string>();

  useEffect(() => {
    if (type !== "image" || !file) {
      setLocal(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setLocal(url);
    return () => URL.revokeObjectURL(url);
  }, [file, type]);

  return local ?? remote;
}

const AttachmentTile: FC = () => {
  const aui = useAui();
  const composer = aui.attachment.source !== "message";
  const preview = useAttachmentPreview();
  const name = useAuiState((state) => state.attachment.name);
  const type = useAuiState((state) => state.attachment.type);
  const status = useAuiState((state) => state.attachment.status);
  const loading = status.type === "running";
  const failed = status.type === "incomplete" && status.reason === "error";

  return (
    <AttachmentPrimitive.Root
      className={cn(
        "group/attachment relative flex min-w-0 items-center gap-2 rounded-xl bg-background px-2 py-1.5 text-xs shadow-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06]",
        composer ? "max-w-48" : "max-w-56",
        failed && "ring-destructive/50"
      )}
    >
      <div className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded bg-muted text-muted-foreground">
        {preview ? <img src={preview} alt="附件预览" className="size-full object-cover" /> : <FileTextIcon className="size-4" />}
        {loading && <div className="absolute grid size-8 place-items-center rounded bg-background/75"><Loader2Icon className="size-3.5 animate-spin" /></div>}
        {failed && <div className="absolute grid size-8 place-items-center rounded bg-background/80 text-destructive"><AlertCircleIcon className="size-3.5" /></div>}
      </div>
      <div className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground"><AttachmentPrimitive.Name /></span>
        <span className="text-[10px] text-muted-foreground">{type === "image" ? "图片" : "文件"}</span>
      </div>
      {composer && (
        <AttachmentPrimitive.Remove asChild>
          <TooltipIconButton tooltip={`移除 ${name}`} className="size-5 rounded opacity-70 hover:opacity-100" aria-label={`移除 ${name}`}>
            <XIcon className="size-3" />
          </TooltipIconButton>
        </AttachmentPrimitive.Remove>
      )}
    </AttachmentPrimitive.Root>
  );
};

export function ComposerAttachments() {
  return (
    <div className="flex w-full gap-2 overflow-x-auto empty:hidden">
      <ComposerPrimitive.Attachments>{() => <AttachmentTile />}</ComposerPrimitive.Attachments>
    </div>
  );
}

export function UserMessageAttachments() {
  return (
    <div className="col-span-full col-start-1 row-start-1 flex w-full flex-wrap justify-end gap-2 empty:hidden">
      <MessagePrimitive.Attachments>{() => <AttachmentTile />}</MessagePrimitive.Attachments>
    </div>
  );
}
