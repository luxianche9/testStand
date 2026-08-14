import type { ActiveExecutionActivity, ExecutionActivity } from "@testforge/contracts/execution";

export interface ExecutionLease { release(): void }

export class ExecutionCoordinator {
  private activity: ExecutionActivity = { state: "idle" };
  private generation = 0;
  private notifier?: (activity: ExecutionActivity) => void;

  current(): ExecutionActivity { return structuredClone(this.activity); }

  setNotifier(notifier: (activity: ExecutionActivity) => void): void { this.notifier = notifier; }

  assertIdle(): void {
    if (this.activity.state !== "idle") throw executionConflict(this.activity);
  }

  acquire(activity: ActiveExecutionActivity): ExecutionLease {
    this.assertIdle();
    const generation = ++this.generation;
    this.activity = structuredClone(activity);
    this.notifier?.(this.current());
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.generation !== generation) return;
        this.activity = { state: "idle" };
        this.notifier?.(this.current());
      }
    };
  }
}

function executionConflict(activity: ExecutionActivity): Error {
  return Object.assign(new Error(executionConflictMessage(activity)), {
    category: "conflict",
    details: { activity: structuredClone(activity) }
  });
}

function executionConflictMessage(activity: ExecutionActivity): string {
  if (activity.state === "manual") return `Manual hardware call ${activity.toolName} is still running`;
  if (activity.state === "run") return `Test run ${activity.runId} is still running`;
  return "Another hardware execution is still running";
}
