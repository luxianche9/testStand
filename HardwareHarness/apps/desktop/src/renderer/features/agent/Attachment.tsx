import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAui,
  useAuiState
} from "@assistant-ui/react";
import { AlertCircleIcon, FileTextIcon, XIcon } from "lucide-react";
import { useEffect, useState, type FC } from "react";
import { cn, IconButton, Spinner } from "../../ui";

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
        "group/attachment relative flex min-w-0 items-center gap-2 rounded-md border bg-surface-2 p-1 text-xs",
        composer ? "max-w-48" : "max-w-56",
        failed ? "border-fail/50" : "border-line"
      )}
    >
      <div
        className={
          "relative grid size-7 shrink-0 place-items-center overflow-hidden rounded-sm border border-line " +
          "bg-surface-0 text-fg-3"
        }
      >
        {preview
          ? <img src={preview} alt="附件预览" className="size-full object-cover" />
          : <FileTextIcon aria-hidden className="size-3.5" />}
        {loading && (
          <div className="absolute inset-0 grid place-items-center bg-surface-0/75 text-run">
            <Spinner className="size-3" />
          </div>
        )}
        {failed && (
          <div className="absolute inset-0 grid place-items-center bg-surface-0/80 text-fail">
            <AlertCircleIcon aria-hidden className="size-3.5" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <span className="block truncate font-mono text-fg"><AttachmentPrimitive.Name /></span>
        <span className="tf-label">{type === "image" ? "图片" : "文件"}</span>
      </div>
      {composer && (
        <AttachmentPrimitive.Remove asChild>
          <IconButton label={`移除 ${name}`} size="icon-xs" className="text-fg-3">
            <XIcon className="size-3" />
          </IconButton>
        </AttachmentPrimitive.Remove>
      )}
    </AttachmentPrimitive.Root>
  );
};

export function ComposerAttachments() {
  return (
    <div className="flex w-full gap-1.5 overflow-x-auto empty:hidden">
      <ComposerPrimitive.Attachments>{() => <AttachmentTile />}</ComposerPrimitive.Attachments>
    </div>
  );
}

export function UserMessageAttachments() {
  return (
    <div className="col-span-full col-start-1 row-start-1 flex w-full flex-wrap justify-end gap-1.5 empty:hidden">
      <MessagePrimitive.Attachments>{() => <AttachmentTile />}</MessagePrimitive.Attachments>
    </div>
  );
}
