import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { errorMessage } from "./errors.js";
import { IconAlert } from "./icons.js";
import { Btn, EmptyState, Spinner } from "./ui.js";

/* --------------------------------- 公共 --------------------------------- */

export function QueryGate<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isLoading) {
    return <div className="centered"><Spinner label="正在加载…" /></div>;
  }
  if (query.isError || !query.data) {
    return (
      <div className="centered">
        <EmptyState
          icon={<IconAlert size={30} />}
          title="无法加载数据"
          {...(query.error ? { body: errorMessage(query.error) } : {})}
          action={<Btn variant="primary" onClick={() => void query.refetch()}>重试</Btn>}
        />
      </div>
    );
  }
  return <>{children(query.data)}</>;
}

export function PageHeader({ title, subtitle, badge, actions }: { title: string; subtitle?: string; badge?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-title">
        <h1>{title}{badge}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function PropRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <span className="prop-value">{children}</span>
    </div>
  );
}
