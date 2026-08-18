import { lazy, Suspense } from "react";
import type { ProjectView } from "@testforge/contracts/storage";
import { Spinner } from "../../shared/ui.js";
import { ErrorBoundary } from "../../shared/ErrorBoundary.js";

const WiringPage = lazy(() => import("../wiring/index.js").then((module) => ({ default: module.WiringPage })));
const OrchestrationPage = lazy(() => import("../orchestration/index.js").then((module) => ({ default: module.OrchestrationPage })));
const DevicesPage = lazy(() => import("../devices/index.js").then((module) => ({ default: module.DevicesPage })));
const LogsPage = lazy(() => import("../logs/index.js").then((module) => ({ default: module.LogsPage })));

export function ProjectWorkspace({ view }: { view: ProjectView }) {
  return (
    <div className="project-workspace">
      <ErrorBoundary key={view}>
        <Suspense fallback={<div className="centered"><Spinner label="正在加载项目功能…" /></div>}>
          {view === "orchestration" ? <OrchestrationPage />
            : view === "wiring" ? <WiringPage />
              : view === "manual" ? <DevicesPage />
                : <LogsPage />}
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
