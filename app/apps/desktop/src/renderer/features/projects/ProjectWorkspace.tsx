import { lazy, Suspense } from "react";
import { ErrorBoundary } from "../../app/ErrorBoundary.js";
import { FeatureFallback } from "../../app/FeatureFallback.js";
import type { SidePanel } from "../../lib/side-panel.js";

const BenchPage = lazy(() => import("../bench/index.js").then((module) => ({ default: module.BenchPage })));

/** The open project: one bench whose sidebar panel the activity bar picks. */
export function ProjectWorkspace({ panel }: { panel: SidePanel | undefined }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
      <ErrorBoundary>
        <Suspense fallback={<FeatureFallback />}><BenchPage panel={panel} /></Suspense>
      </ErrorBoundary>
    </div>
  );
}
