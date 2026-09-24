import { Skeleton, Spinner } from "../ui";

/** Suspense fallback for lazily loaded pages and the AI sidebar. */
export function FeatureFallback({ label = "正在加载…" }: { label?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 flex-none items-center gap-3 border-b border-line bg-surface-1 px-3">
        <Skeleton className="h-3 w-28" />
        <span className="flex-1" />
        <Skeleton className="h-6 w-20" />
      </div>
      <div className="grid flex-1 place-items-center text-fg-3">
        <Spinner label={label} />
      </div>
    </div>
  );
}
