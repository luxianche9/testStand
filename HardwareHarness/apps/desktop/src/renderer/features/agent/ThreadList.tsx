import { AuiIf, ThreadListPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { PlusIcon, SearchIcon } from "lucide-react";
import { forwardRef, Fragment, useMemo, useState, type FC } from "react";
import { buttonVariants, cn, Input, Skeleton, Spinner, type ButtonProps } from "../../ui";
import { CloseDrawerContext, ThreadListItem } from "./ThreadListItem";

const errorMessage = (reason: unknown) =>
  reason === undefined ? undefined : reason instanceof Error ? reason.message : String(reason);

export const ThreadList: FC<{ onThreadSelected?: () => void }> = ({ onThreadSelected = () => undefined }) => {
  const [search, setSearch] = useState("");
  const [createError, setCreateError] = useState<string>();
  const hasThreads = useAuiState((state) => state.threads.threadIds.length > 0);
  return (
    <CloseDrawerContext.Provider value={onThreadSelected}>
      <ThreadListPrimitive.Root className="flex flex-col gap-1">
        <ThreadListNew
          onCreated={() => {
            setCreateError(undefined);
            onThreadSelected();
          }}
          onCreateError={(reason) => setCreateError(errorMessage(reason))}
        />
        {createError && (
          <div role="alert" className="rounded-sm border border-fail/35 bg-fail/8 px-2.5 py-2 text-xs text-fail">
            {`新建会话失败：${createError}`}
          </div>
        )}
        {hasThreads && <ThreadListSearch value={search} onValueChange={setSearch} />}
        <div className="flex flex-col gap-px">
          <AuiIf condition={(state) => state.threads.isLoading}><ThreadListSkeleton /></AuiIf>
          <AuiIf condition={(state) => !state.threads.isLoading}>
            <ThreadListItemGroups searchQuery={hasThreads ? search : ""} />
          </AuiIf>
        </div>
      </ThreadListPrimitive.Root>
    </CloseDrawerContext.Provider>
  );
};

function ThreadListSearch({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) {
  return (
    <div className="relative">
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-3"
      />
      <Input
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-label="搜索会话"
        placeholder="搜索会话"
        className="ps-7"
      />
    </div>
  );
}

const DAY = 86_400_000;
function dateGroupLabel(date: Date | undefined, today: number) {
  if (!date || date.getTime() >= today) return "今天";
  if (date.getTime() >= today - DAY) return "昨天";
  return "更早";
}

type DateGroup = { label: string; indices: number[] };

const ThreadListItemGroups: FC<{ searchQuery?: string }> = ({ searchQuery = "" }) => {
  const threadIds = useAuiState((state) => state.threads.threadIds);
  const threadItems = useAuiState((state) => state.threads.threadItems);
  const query = searchQuery.trim().toLocaleLowerCase("zh-CN");
  const { filtered, groups } = useMemo(() => {
    const byId = new Map(threadItems.map((item) => [item.id, item]));
    const dates = threadIds.map((id) => byId.get(id)?.lastMessageAt);
    const matches = (id: string) => (byId.get(id)?.title || "新对话").toLocaleLowerCase("zh-CN").includes(query);
    const filtered = threadIds
      .map((id, index) => ({ id, index }))
      .filter(({ id }) => !query || matches(id))
      .map(({ index }) => index);
    if (!filtered.some((index) => dates[index])) return { filtered, groups: null as DateGroup[] | null };
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const time = (index: number) => dates[index]?.getTime() ?? 0;
    const sorted = [...filtered].sort((left, right) => time(right) - time(left));
    const groups: DateGroup[] = [];
    for (const index of sorted) {
      const label = dateGroupLabel(dates[index], today);
      const tail = groups.at(-1);
      if (tail?.label === label) tail.indices.push(index);
      else groups.push({ label, indices: [index] });
    }
    return { filtered, groups };
  }, [query, threadIds, threadItems]);

  const item = (index: number) => (
    <ThreadListPrimitive.ItemByIndex key={threadIds[index]} index={index} components={{ ThreadListItem }} />
  );
  if (query && !filtered.length) return <div className="px-2.5 py-4 text-sm text-fg-3">没有匹配的会话</div>;
  if (!groups) return filtered.map(item);
  return groups.map((group) => (
    <Fragment key={group.label}>
      <div className="tf-label px-2.5 pt-3 pb-1">{group.label}</div>
      {group.indices.map(item)}
    </Fragment>
  ));
};

const ThreadListNew = forwardRef<
  HTMLButtonElement,
  ButtonProps & {
    labelClassName?: string;
    onCreated?: () => void;
    onCreateError?: (reason: unknown) => void;
  }
>(({
  className,
  labelClassName,
  children,
  onCreated,
  onCreateError,
  onClick,
  disabled,
  variant = "outline",
  size = "sm",
  asChild: _asChild,
  ...props
}, ref) => {
  const aui = useAui();
  const [creating, setCreating] = useState(false);

  return (
    <ThreadListPrimitive.New asChild>
      <button
        ref={ref}
        type="button"
        className={cn(buttonVariants({ variant, size }), "justify-start border-dashed font-normal", className)}
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
            {creating ? <Spinner className="size-3.5" /> : <PlusIcon className="size-3.5 shrink-0" />}
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
    <div className="flex flex-col gap-px">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} role="status" aria-label="正在加载会话" className="flex h-7 items-center px-2.5">
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  );
}
