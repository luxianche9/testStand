import { Skeleton } from "./ui/skeleton";
import { Spinner } from "./ui/skeleton";

export function FeatureFallback() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex h-12 flex-none items-center gap-3 border-b border-border bg-card px-4">
        <Skeleton className="h-4 w-28" />
        <span className="flex-1" />
        <Skeleton className="h-7 w-20 rounded-md" />
      </div>
      <div className="grid flex-1 place-items-center">
        <Spinner label="正在加载…" />
      </div>
    </div>
  );
}
