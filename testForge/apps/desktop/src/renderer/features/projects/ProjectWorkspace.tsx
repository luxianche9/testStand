import { lazy, Suspense } from "react";
import { Spinner } from "../../shared/ui.js";

const WiringPage = lazy(() => import("../wiring/index.js").then((module) => ({ default: module.WiringPage })));
const OrchestrationPage = lazy(() => import("../orchestration/index.js").then((module) => ({ default: module.OrchestrationPage })));
const ManualControlPage = lazy(() => import("../manual/index.js").then((module) => ({ default: module.ManualControlPage })));
const LogsPage = lazy(() => import("../logs/index.js").then((module) => ({ default: module.LogsPage })));

export type ProjectView = "wiring" | "orchestration" | "manual" | "logs";

export function ProjectWorkspace({ view }: { view: ProjectView }) {
  return (
    <div className="project-workspace">
      <Suspense fallback={<div className="centered"><Spinner label="正在加载项目功能…" /></div>}>
        {view === "orchestration" ? <OrchestrationPage />
          : view === "wiring" ? <WiringPage />
            : view === "manual" ? <ManualControlPage />
              : <LogsPage />}
      </Suspense>
    </div>
  );
}
