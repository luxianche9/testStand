import { activeExecutionActivities } from "@hardwareharness/contracts/execution";
import type { DashboardSnapshot } from "@hardwareharness/contracts/desktop";
import type { ProjectDocument } from "@hardwareharness/contracts/projects";
import { StatusLamp, cn } from "../ui";

/** Bottom instrument strip: gateway, live execution and project location. */
export function StatusBar({ dashboard, project }: {
  dashboard: DashboardSnapshot | undefined;
  project: ProjectDocument | null | undefined;
}) {
  const gateway = dashboard?.gateway;
  const activities = activeExecutionActivities(dashboard?.execution);
  // The local computer needs no SSH link, so it always counts as reachable.
  const reachable = (computerId: string) => dashboard?.statuses
    .some((status) => status.computerId === computerId && status.ssh.state === "online") ?? false;
  const online = dashboard?.computers
    .filter((computer) => computer.execution === "local" || reachable(computer.id)).length ?? 0;
  const computers = dashboard?.computers.length ?? 0;

  return (
    <footer
      aria-label="状态栏"
      className={cn(
        "flex h-6 flex-none items-center gap-4 border-t border-line bg-surface-1 px-3 text-2xs text-fg-3",
        "select-none"
      )}
    >
      <span className="flex items-center gap-1.5" title={gateway?.lastError ?? gateway?.endpoint}>
        <StatusLamp tone={!gateway ? "neutral" : gateway.running ? "pass" : "fail"} className="size-1.5" />
        <span>网关</span>
        <span className="tf-num text-fg-2">{gateway ? (gateway.running ? `${gateway.toolCount} 工具` : "离线") : "—"}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <StatusLamp
          tone={computers && online === computers ? "pass" : online ? "invalid" : "neutral"}
          className="size-1.5"
        />
        <span>工位电脑</span>
        <span className="tf-num text-fg-2">{online}/{computers}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusLamp tone={activities.length ? "run" : "neutral"} pulse={activities.length > 0} className="size-1.5" />
        <span className="truncate">
          {activities.length === 0 ? "空闲"
            : activities.map((item) => item.state === "run" ? "测试运行中" : `手动 · ${item.toolName}`).join(" · ")}
        </span>
      </span>
      <span className="flex-1" />
      {project && (
        <span className="tf-num max-w-[50%] truncate" title={project.rootPath}>{project.rootPath}</span>
      )}
    </footer>
  );
}
