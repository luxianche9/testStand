import { ActionBarPrimitive, ComposerPrimitive, MessagePrimitive } from "@assistant-ui/react";
import { PencilIcon } from "lucide-react";
import { Button, IconButton } from "../../ui";
import { BranchPicker } from "./AssistantMessage";
import { UserMessageAttachments } from "./Attachment";

export function UserMessage() {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className={
        "grid auto-rows-auto grid-cols-[minmax(56px,1fr)_auto] content-start gap-y-1.5 " +
        "[contain-intrinsic-size:auto_160px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      }
    >
      <UserMessageAttachments />
      <div className="relative col-start-2 min-w-0">
        <div
          className={
            "peer rounded-md border border-line bg-surface-2 px-3 py-1.5 text-sm leading-relaxed text-fg " +
            "wrap-break-word empty:hidden"
          }
        >
          <MessagePrimitive.Parts />
        </div>
        <div className="absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-1 peer-empty:hidden">
          <UserActionBar />
        </div>
      </div>
      <BranchPicker className="col-span-full col-start-1 row-start-3 -me-1 justify-end" />
    </MessagePrimitive.Root>
  );
}

function UserActionBar() {
  return (
    <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex flex-col items-end text-fg-3">
      <ActionBarPrimitive.Edit asChild>
        <IconButton label="编辑" size="icon-sm"><PencilIcon /></IconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
}

export function EditComposer() {
  return (
    <MessagePrimitive.Root className="flex flex-col">
      <ComposerPrimitive.Root
        className={
          "ms-auto flex w-full max-w-[88%] flex-col rounded-md border border-line-strong bg-surface-0 " +
          "transition-colors duration-120 focus-within:border-signal"
        }
      >
        <ComposerPrimitive.Input
          className="min-h-14 w-full resize-none bg-transparent px-3 pt-2 pb-1 text-sm text-fg outline-none"
          autoFocus
        />
        <div className="mx-2 mb-2 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild><Button variant="ghost" size="xs">取消</Button></ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild><Button variant="primary" size="xs">更新</Button></ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}
