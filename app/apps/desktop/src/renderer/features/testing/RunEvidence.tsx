import { AlertTriangleIcon, CopyIcon } from "lucide-react";
import { cn, IconButton } from "../../ui";

export function CopyableId({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <code className={cn("truncate font-mono text-fg-3", compact ? "max-w-24 text-[9px]" : "text-2xs")}>
        {compact ? value.slice(0, 10) : `${label}: ${value}`}
      </code>
      <IconButton
        label={`复制 ${label}`}
        size="icon-xs"
        variant="ghost"
        tooltip={false}
        className="size-5"
        onClick={() => void navigator.clipboard?.writeText(value)}
      >
        <CopyIcon />
      </IconButton>
    </span>
  );
}

export function InlineWarning({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-invalid/40 bg-invalid/10 px-3 py-2",
        "text-xs text-invalid"
      )}
    >
      <AlertTriangleIcon className="size-4 shrink-0" />
      {children}
    </div>
  );
}
