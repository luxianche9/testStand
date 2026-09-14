import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { CircleAlertIcon } from "lucide-react";
import { errorMessage } from "./errors.js";
import { cn } from "./ui/cn";
import { Button } from "./ui/button";
import { EmptyState } from "./ui/empty-state";
import { Spinner } from "./ui/skeleton";

/* --------------------------------- 公共 --------------------------------- */

export function QueryGate<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isLoading) {
    return <div className="grid min-h-[60vh] place-items-center"><Spinner label="正在加载…" /></div>;
  }
  if (query.isError || !query.data) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <EmptyState
          icon={<CircleAlertIcon className="size-8" />}
          title="无法加载数据"
          {...(query.error ? { body: errorMessage(query.error) } : {})}
          action={<Button onClick={() => void query.refetch()}>重试</Button>}
        />
      </div>
    );
  }
  return <>{children(query.data)}</>;
}

export function PageHeader({ title, subtitle, badge, actions }: { title: string; subtitle?: string; badge?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex items-start justify-between gap-5">
      <div className="min-w-0">
        <h1 className="m-0 text-[17px] font-semibold tracking-tight">{title}{badge}</h1>
        {subtitle && <p className="mt-1.5 mb-0 max-w-[65ch] text-[13px] leading-relaxed text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-none flex-wrap justify-end gap-2">{actions}</div>}
    </header>
  );
}

export function PropRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid min-h-7 grid-cols-[140px_minmax(0,1fr)] items-center gap-3 px-4 py-2 odd:bg-secondary/25", className)}>
      <span className="text-[11.5px] tracking-wide text-muted-foreground">{label}</span>
      <span className="min-w-0 wrap-anywhere text-[13px] [&_code]:text-[12px] [&_code]:tabular-nums">{children}</span>
    </div>
  );
}
