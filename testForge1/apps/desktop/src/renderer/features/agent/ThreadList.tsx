import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon
} from "lucide-react";
import {
  createContext,
  forwardRef,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FC
} from "react";
import { Button, buttonVariants, Input, Skeleton } from "./ui";
import { cn } from "./utils";

const CloseDrawerContext = createContext<() => void>(() => undefined);

export const ThreadList: FC<{ onThreadSelected?: () => void }> = ({ onThreadSelected = () => undefined }) => {
  const [search, setSearch] = useState("");
  const [createError, setCreateError] = useState<string>();
  const hasThreads = useAuiState((state) => state.threads.threadIds.length > 0);
  return (
    <CloseDrawerContext.Provider value={onThreadSelected}>
      <ThreadListRoot>
        <ThreadListNew
          onCreated={() => {
            setCreateError(undefined);
            onThreadSelected();
          }}
          onCreateError={(reason) => setCreateError(reason === undefined ? undefined : reason instanceof Error ? reason.message : String(reason))}
        />
        {createError && (
          <div role="alert" className="mx-0.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
            {`新建会话失败：${createError}`}
          </div>
        )}
        {hasThreads && <ThreadListSearch value={search} onValueChange={setSearch} />}
        <ThreadListItems searchQuery={hasThreads ? search : ""} />
      </ThreadListRoot>
    </CloseDrawerContext.Provider>
  );
};

const ThreadListSearch = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<typeof Input>, "value" | "onChange"> & { value: string; onValueChange: (value: string) => void }
>(({ className, value, onValueChange, ...props }, ref) => (
  <div className="relative px-0.5 py-1">
    <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    <Input
      ref={ref}
      type="search"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      aria-label="搜索会话"
      placeholder="搜索会话"
      className={cn("h-8 ps-8 text-sm", className)}
      {...props}
    />
  </div>
));
ThreadListSearch.displayName = "ThreadListSearch";

const ThreadListRoot: FC<ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>> = ({ className, ...props }) => (
  <ThreadListPrimitive.Root className={cn("flex flex-col gap-0.5", className)} {...props} />
);

const ThreadListItems: FC<ComponentPropsWithoutRef<"div"> & { searchQuery?: string }> = ({ className, searchQuery = "", ...props }) => (
  <div className={cn("flex flex-col gap-0.5", className)} {...props}>
    <AuiIf condition={(state) => state.threads.isLoading}><ThreadListSkeleton /></AuiIf>
    <AuiIf condition={(state) => !state.threads.isLoading}><ThreadListItemGroups searchQuery={searchQuery} /></AuiIf>
  </div>
);

const DAY = 86_400_000;
function dateGroupLabel(date: Date | undefined, today: number) {
  if (!date || date.getTime() >= today) return "今天";
  if (date.getTime() >= today - DAY) return "昨天";
  return "更早";
}

const ThreadListItemGroups: FC<{ searchQuery?: string }> = ({ searchQuery = "" }) => {
  const threadIds = useAuiState((state) => state.threads.threadIds);
  const threadItems = useAuiState((state) => state.threads.threadItems);
  const query = searchQuery.trim().toLocaleLowerCase("zh-CN");
  const { filtered, groups } = useMemo(() => {
    const byId = new Map(threadItems.map((item) => [item.id, item]));
    const dates = threadIds.map((id) => byId.get(id)?.lastMessageAt);
    const filtered = threadIds
      .map((id, index) => ({ id, index }))
      .filter(({ id }) => !query || (byId.get(id)?.title || "新对话").toLocaleLowerCase("zh-CN").includes(query))
      .map(({ index }) => index);
    if (!filtered.some((index) => dates[index])) return { filtered, groups: null as { label: string; indices: number[] }[] | null };
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const sorted = [...filtered].sort((left, right) => (dates[right]?.getTime() ?? 0) - (dates[left]?.getTime() ?? 0));
    const groups: { label: string; indices: number[] }[] = [];
    for (const index of sorted) {
      const label = dateGroupLabel(dates[index], today);
      const tail = groups.at(-1);
      if (tail?.label === label) tail.indices.push(index);
      else groups.push({ label, indices: [index] });
    }
    return { filtered, groups };
  }, [query, threadIds, threadItems]);

  if (query && !filtered.length) return <div className="px-2.5 py-4 text-sm text-muted-foreground">没有匹配的会话</div>;
  if (!groups) return filtered.map((index) => <ThreadListPrimitive.ItemByIndex key={threadIds[index]} index={index} components={{ ThreadListItem }} />);
  return groups.map((group) => (
    <Fragment key={group.label}>
      <div className="px-2.5 pt-3 pb-1 text-xs font-medium text-muted-foreground">{group.label}</div>
      {group.indices.map((index) => <ThreadListPrimitive.ItemByIndex key={threadIds[index]} index={index} components={{ ThreadListItem }} />)}
    </Fragment>
  ));
};

const ThreadListNew = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof Button> & {
    labelClassName?: string;
    onCreated?: () => void;
    onCreateError?: (reason: unknown) => void;
  }
>(({ className, labelClassName, children, onCreated, onCreateError, onClick, disabled, variant = "ghost", size = "default", asChild: _asChild, ...props }, ref) => {
  const aui = useAui();
  const [creating, setCreating] = useState(false);

  return (
    <ThreadListPrimitive.New asChild>
      <button
        ref={ref}
        type="button"
        className={cn(
          buttonVariants({ variant, size }),
          "h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal hover:bg-muted data-active:bg-muted",
          className
        )}
        disabled={disabled || creating}
        aria-busy={creating || undefined}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented) return;

          // Prevent the primitive's fire-and-forget switch. OpenCode's adapter
          // needs the new remote session before its runtime can enable the
          // composer, so perform and await the complete assistant-ui flow.
          event.preventDefault();
          setCreating(true);
          onCreateError?.(undefined);
          void (async () => {
            try {
              const runtime = aui.threads.__internal_getAssistantRuntime?.();
              if (!runtime) throw new Error("OpenCode 会话运行时尚未就绪");
              await runtime.threads.switchToNewThread();
              if (runtime.threads.mainItem.getState().status === "new") {
                await runtime.threads.mainItem.initialize();
              }
              onCreated?.();
            } catch (reason: unknown) {
              onCreateError?.(reason);
            } finally {
              setCreating(false);
            }
          })();
        }}
        {...props}
      >
        {children ?? (
          <>
            {creating ? <Loader2Icon className="size-4 shrink-0 animate-spin" /> : <PlusIcon className="size-4 shrink-0" />}
            <span className={cn("whitespace-nowrap", labelClassName)}>{creating ? "正在新建" : "新建对话"}</span>
          </>
        )}
      </button>
    </ThreadListPrimitive.New>
  );
});
ThreadListNew.displayName = "ThreadListNew";

function ThreadListSkeleton() {
  return (
    <div className="flex flex-col gap-0.5">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} role="status" aria-label="正在加载会话" className="flex h-8 items-center px-2.5">
          <Skeleton className="h-3.5 w-full" />
        </div>
      ))}
    </div>
  );
}

const ThreadListItem: FC = () => {
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
    <ThreadListItemPrimitive.Root className="group relative flex h-8 items-center rounded-md transition-colors hover:bg-muted has-focus-visible:bg-muted has-data-[state=open]:bg-muted data-active:bg-muted">
      {renaming ? (
        <ThreadListItemRename onDone={(restore) => { restoreFocus.current = restore; setRenaming(false); }} />
      ) : (
        <ThreadListItemPrimitive.Trigger
          ref={triggerRef}
          className="flex h-full min-w-0 flex-1 items-center rounded-md px-2.5 text-start text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/45 group-hover:pe-9 group-data-active:pe-9"
          onClick={() => window.setTimeout(closeDrawer, 0)}
        >
          {running && <Loader2Icon className="me-1.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />}
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
      className="h-7 min-w-0 flex-1 ps-2.5 pe-9 text-sm"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => commit(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(true); }
        else if (event.key === "Escape") { event.preventDefault(); settled.current = true; onDone(true); }
      }}
    />
  );
}

function ThreadListItemMore({ onRename }: { onRename: () => void }) {
  return (
    <ThreadListItemMorePrimitive.Root sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button variant="ghost" size="icon-xs" className="absolute end-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-data-active:opacity-100 data-[state=open]:bg-accent data-[state=open]:opacity-100">
          <MoreHorizontalIcon className="size-3.5" /><span className="sr-only">更多操作</span>
        </Button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        className="tf-agent-theme z-[100] min-w-32 overflow-hidden rounded-xl border bg-popover/95 p-1.5 text-popover-foreground shadow-lg backdrop-blur-sm"
      >
        <ThreadListItemMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none hover:bg-accent focus:bg-accent" onSelect={onRename}>
          <PencilIcon className="size-4" />重命名
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemPrimitive.Archive asChild>
          <ThreadListItemMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none hover:bg-accent focus:bg-accent">
            <ArchiveIcon className="size-4" />归档
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Archive>
        <ThreadListItemPrimitive.Delete asChild>
          <ThreadListItemMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-destructive outline-none hover:bg-destructive/10 focus:bg-destructive/10">
            <TrashIcon className="size-4" />删除
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Delete>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
}
