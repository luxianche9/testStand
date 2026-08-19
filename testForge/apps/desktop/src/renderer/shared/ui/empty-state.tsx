import type { ReactNode } from "react";
import { cn } from "./cn";

export function EmptyState({ icon, title, body, action, className }: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid place-items-center gap-2 px-5 py-11 text-center text-muted-foreground", className)}>
      {icon && <span className="text-muted-foreground/60 [&_svg]:size-8">{icon}</span>}
      <h2 className="m-0 text-base font-medium text-foreground">{title}</h2>
      {body && <p className="m-0 max-w-md text-sm">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** 居中的整页加载/错误容器。 */
export function Centered({ children }: { children: ReactNode }) {
  return <div className="grid min-h-[60vh] place-items-center">{children}</div>;
}
