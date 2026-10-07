import { lazy, Suspense, useState } from "react";
import type { ProjectView } from "@teststand/contracts/storage";
import { ErrorBoundary } from "../../app/ErrorBoundary.js";
import { FeatureFallback } from "../../app/FeatureFallback.js";
import { cn } from "../../ui/index.js";

const BenchPage = lazy(() => import("../bench/index.js").then((module) => ({ default: module.BenchPage })));
const TestPlanPage = lazy(() => import("../testing/index.js").then((module) => ({ default: module.TestPlanPage })));
const RunMonitorPage = lazy(() => import("../testing/index.js").then((module) => ({ default: module.RunMonitorPage })));

const PAGES: Record<ProjectView, () => React.ReactNode> = {
  bench: () => <BenchPage />,
  plans: () => <TestPlanPage />,
  runs: () => <RunMonitorPage />
};

/**
 * The project's pages. A page stays mounted once opened and is only hidden when another is shown,
 * so switching back neither reloads it nor loses what it shows (the signal view keeps its live data).
 */
export function ProjectWorkspace({ view }: { view: ProjectView }) {
  const [opened, setOpened] = useState<ProjectView[]>([view]);
  if (!opened.includes(view)) setOpened([...opened, view]);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
      {opened.map((page) => (
        <div key={page} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", page !== view && "hidden")}>
          <ErrorBoundary>
            <Suspense fallback={<FeatureFallback />}>{PAGES[page]()}</Suspense>
          </ErrorBoundary>
        </div>
      ))}
    </div>
  );
}
