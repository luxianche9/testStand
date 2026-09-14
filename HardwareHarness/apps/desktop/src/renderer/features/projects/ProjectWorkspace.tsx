import { lazy, Suspense } from "react";
import type { ProjectView } from "@hardwareharness/contracts/storage";
import { Centered } from "../../shared/ui/index.js";
import { FeatureFallback } from "../../shared/FeatureFallback.js";
import { ErrorBoundary } from "../../shared/ErrorBoundary.js";

const WiringPage = lazy(() => import("../wiring/index.js").then((module) => ({ default: module.WiringPage })));
const OrchestrationPage = lazy(() => import("../orchestration/index.js").then((module) => ({ default: module.OrchestrationPage })));
const DevicesPage = lazy(() => import("../devices/index.js").then((module) => ({ default: module.DevicesPage })));
const LogsPage = lazy(() => import("../logs/index.js").then((module) => ({ default: module.LogsPage })));

export function ProjectWorkspace({ view }: { view: ProjectView }) {
  return (
    <div className="grid h-full min-h-0 min-w-0 flex-1 bg-background">
      <ErrorBoundary key={view}>
        <Suspense fallback={<FeatureFallback />}>
          <div className="animate-page-in contents">
            {view === "orchestration" ? <OrchestrationPage />
              : view === "wiring" ? <WiringPage />
                : view === "manual" ? <DevicesPage />
                  : <LogsPage />}
          </div>
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
