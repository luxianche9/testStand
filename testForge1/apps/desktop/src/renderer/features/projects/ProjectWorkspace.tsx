import { lazy, Suspense } from "react";
import { Spinner } from "../../shared/ui.js";

const WiringPage = lazy(() => import("../wiring/index.js").then((module) => ({ default: module.WiringPage })));
const OrchestrationPage = lazy(() => import("../orchestration/index.js").then((module) => ({ default: module.OrchestrationPage })));

export type ProjectView = "wiring" | "orchestration" | "manual" | "logs";

const VIEW_TITLES: Record<ProjectView, string> = {
  wiring: "工位接线",
  orchestration: "编排测试",
  manual: "手动控制",
  logs: "运行日志"
};

export function ProjectWorkspace({ view }: { view: ProjectView }) {
  return (
    <div className="project-workspace">
      <Suspense fallback={<div className="centered"><Spinner label="正在加载项目功能…" /></div>}>
        {view === "orchestration" ? <OrchestrationPage />
          : view === "wiring" ? <WiringPage />
            : <PlaceholderPage title={VIEW_TITLES[view]} />}
      </Suspense>
    </div>
  );
}

function PlaceholderPage({ title }: { title: string }) {
  return <div className="workspace-placeholder"><p>{title}页面尚未实现</p></div>;
}
