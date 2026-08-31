import type { ReactNode } from "react";
import { cn } from "./ui/cn";
import type { useResizableWidth } from "./resizable.js";

type SidebarConfig = {
  content: ReactNode;
  width: ReturnType<typeof useResizableWidth>;
  position: "left" | "right";
};

export function FeatureLayout({ header, children, sidebar, className }: {
  header?: ReactNode;
  children: ReactNode;
  sidebar?: SidebarConfig;
  className?: string;
}) {
  if (!sidebar) {
    return (
      <main className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
        {header}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </main>
    );
  }

  const sidebarPanel = (
    <div className="min-h-0 overflow-auto bg-card p-3">
      {sidebar.content}
    </div>
  );
  const separator = (
    <div
      className="w-1 cursor-col-resize bg-transparent transition-colors hover:bg-ring/30"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖拽调整面板宽度"
      title="拖拽调整宽度"
      {...sidebar.width.handleProps}
    />
  );
  const mainContent = (
    <section className="flex min-h-0 min-w-0 flex-col">{children}</section>
  );

  const cols = sidebar.position === "left"
    ? `${sidebar.width.width}px 4px minmax(0, 1fr)`
    : `minmax(0, 1fr) 4px ${sidebar.width.width}px`;

  return (
    <main className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
      {header}
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: cols }}>
        {sidebar.position === "left" ? <>{sidebarPanel}{separator}{mainContent}</> : <>{mainContent}{separator}{sidebarPanel}</>}
      </div>
    </main>
  );
}

export function FeatureHeader({ title, actions, children, className }: {
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-none flex-wrap items-center gap-2.5 bg-card/90 px-4 py-2.5", className)}>
      <h1 className="m-0 text-[15px] font-semibold tracking-tight whitespace-nowrap">{title}</h1>
      {children}
      {actions && <><span className="flex-1" />{actions}</>}
    </div>
  );
}
