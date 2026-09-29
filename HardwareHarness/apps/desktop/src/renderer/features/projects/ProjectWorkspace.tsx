import { lazy, Suspense } from "react";
import type { ProjectView } from "@hardwareharness/contracts/storage";
import { ErrorBoundary } from "../../app/ErrorBoundary.js";
import { FeatureFallback } from "../../app/FeatureFallback.js";

const WiringPage = lazy(() => import("../wiring/index.js").then((module) => ({ default: module.WiringPage })));
const DevicesPage = lazy(() => import("../devices/index.js").then((module) => ({ default: module.DevicesPage })));
const TestPlanPage = lazy(() => import("../testing/index.js").then((module) => ({ default: module.TestPlanPage })));
const RunLogPage = lazy(() => import("../testing/index.js").then((module) => ({ default: module.RunLogPage })));

export function ProjectWorkspace({ view }: { view: ProjectView }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
      <ErrorBoundary key={view}>
        <Suspense fallback={<FeatureFallback />}>
          {view === "wiring" ? <WiringPage />
            : view === "plans" ? <TestPlanPage />
              : view === "runs" ? <RunLogPage />
                : <DevicesPage />}
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
