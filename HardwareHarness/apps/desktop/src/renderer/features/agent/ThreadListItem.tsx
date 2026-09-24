import {
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  useAui,
  useAuiState
} from "@assistant-ui/react";
import { ArchiveIcon, MoreHorizontalIcon, PencilIcon, TrashIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type FC } from "react";
import { Button, cn, Input, StatusLamp } from "../../ui";

export const CloseDrawerContext = createContext<() => void>(() => undefined);

export const ThreadListItem: FC = () => {
  const running = useAuiState((state) => state.threadListItem.isRunning);
  const closeDrawer = useContext(CloseDrawerContext);
  const [renaming, setRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!renaming && restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [renaming]);
  return (
    <ThreadListItemPrimitive.Root
      className={cn(
        "group relative flex h-7 items-center rounded-sm transition-colors duration-120",
        "hover:bg-surface-2 has-focus-visible:bg-surface-2 has-data-[state=open]:bg-surface-2",
        "data-active:bg-surface-2 data-active:text-fg",
        "before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-signal",
        "before:opacity-0 data-active:before:opacity-100"
      )}
    >
      {renaming ? (
        <ThreadListItemRename onDone={(restore) => { restoreFocus.current = restore; setRenaming(false); }} />
      ) : (
        <ThreadListItemPrimitive.Trigger
          ref={triggerRef}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm px-2.5 text-start text-sm text-fg-2 outline-none",
            "group-hover:pe-8 group-hover:text-fg group-data-active:pe-8 group-data-active:text-fg",
            "focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-signal"
          )}
          onClick={() => window.setTimeout(closeDrawer, 0)}
        >
          {running && <StatusLamp tone="run" pulse />}
          <span className="min-w-0 flex-1 truncate"><ThreadListItemPrimitive.Title fallback="新对话" /></span>
          {running && <span className="sr-only">运行中</span>}
        </ThreadListItemPrimitive.Trigger>
      )}
      <ThreadListItemMore onRename={() => setRenaming(true)} />
    </ThreadListItemPrimitive.Root>
  );
};

function ThreadListItemRename({ onDone }: { onDone: (restoreFocus: boolean) => void }) {
  const aui = useAui();
  const title = useAuiState((state) => state.threadListItem.title) ?? "";
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => inputRef.current?.select(), []);
  const commit = (restore: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = value.trim();
    if (!next || next === title) return onDone(restore);
    void Promise.resolve().then(() => aui.threadListItem.rename(next)).then(
      () => onDone(restore),
      () => { settled.current = false; if (restore) inputRef.current?.focus(); }
    );
  };
  return (
    <Input
      ref={inputRef}
      autoFocus
      aria-label="重命名会话"
      value={value}
      className="h-7 min-w-0 flex-1 ps-2.5 pe-8"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => commit(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(true); }
        else if (event.key === "Escape") { event.preventDefault(); settled.current = true; onDone(true); }
      }}
    />
  );
}

const menuItemClass = cn(
  "flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-sm outline-none select-none",
  "data-[highlighted]:bg-surface-2 [&_svg]:size-3.5 [&_svg]:text-fg-3"
);

function ThreadListItemMore({ onRename }: { onRename: () => void }) {
  return (
    <ThreadListItemMorePrimitive.Root sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="更多操作"
          className={cn(
            "absolute end-1 top-1/2 -translate-y-1/2 opacity-0",
            "group-hover:opacity-100 group-has-focus-visible:opacity-100 group-data-active:opacity-100",
            "data-[state=open]:bg-surface-3 data-[state=open]:opacity-100"
          )}
        >
          <MoreHorizontalIcon className="size-3.5" />
        </Button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        className={
          "z-[110] min-w-32 animate-fade-in overflow-hidden rounded-md border border-line-strong bg-surface-3 " +
          "p-1 text-fg shadow-overlay"
        }
      >
        <ThreadListItemMorePrimitive.Item className={menuItemClass} onSelect={onRename}>
          <PencilIcon />重命名
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemPrimitive.Archive asChild>
          <ThreadListItemMorePrimitive.Item className={menuItemClass}>
            <ArchiveIcon />归档
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Archive>
        <ThreadListItemPrimitive.Delete asChild>
          <ThreadListItemMorePrimitive.Item className={cn(menuItemClass, "text-fail [&_svg]:text-fail")}>
            <TrashIcon />删除
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Delete>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
}
