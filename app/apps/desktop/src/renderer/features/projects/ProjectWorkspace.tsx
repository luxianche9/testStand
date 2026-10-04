import { lazy, Suspense } from "react";
import type { ProjectView } from "@teststand/contracts/storage";
import { ErrorBoundary } from "../../app/ErrorBoundary.js";
import { FeatureFallback } from "../../app/FeatureFallback.js";

const BenchPage = lazy(() => import("../bench/index.js").then((module) => ({ default: module.BenchPage })));
const TestPlanPage = lazy(() => import("../testing/index.js").then((module) => ({ default: module.TestPlanPage })));
const RunMonitorPage = lazy(() => import("../testing/index.js").then((module) => ({ default: module.RunMonitorPage })));

export function ProjectWorkspace({ view }: { view: ProjectView }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
      <ErrorBoundary key={view}>
        <Suspense fallback={<FeatureFallback />}>
          {view === "plans" ? <TestPlanPage /> : view === "runs" ? <RunMonitorPage /> : <BenchPage />}
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
