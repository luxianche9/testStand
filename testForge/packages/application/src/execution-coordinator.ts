import { executionHardwareIds, type ActiveExecutionActivity, type ExecutionActivity } from "@testforge/contracts/execution";
import { appError } from "@testforge/contracts/errors";

export interface ExecutionLease { release(): void }

interface LeaseHolder {
  leaseId: number;
  activity: ActiveExecutionActivity;
  keys: { hardwareId: string; generation: number }[];
}

export class ExecutionCoordinator {
  private readonly holders = new Map<number, LeaseHolder>();
  private readonly hardwareHolders = new Map<string, { leaseId: number; generation: number }>();
  private readonly generations = new Map<string, number>();
  private nextLeaseId = 0;
  private notifier?: (activity: ExecutionActivity) => void;

  current(): ExecutionActivity {
    const activities = [...this.holders.values()]
      .map((holder) => holder.activity)
      .sort(compareActivities);
    if (activities.length === 0) return { state: "idle" };
    const representative = activities.find((activity) => activity.state === "run") ?? activities[0]!;
    if (activities.length === 1) return structuredClone(representative);
    return { ...structuredClone(representative), activities: structuredClone(activities) };
  }

  setNotifier(notifier: (activity: ExecutionActivity) => void): void { this.notifier = notifier; }

  acquire(activity: ActiveExecutionActivity): ExecutionLease {
    const normalized = normalizeActivity(activity);
    const hardwareIds = executionHardwareIds(normalized);
    const conflicts = hardwareIds.flatMap((hardwareId) => {
      const keyHolder = this.hardwareHolders.get(hardwareId);
      const holder = keyHolder ? this.holders.get(keyHolder.leaseId) : undefined;
      return holder ? [{ hardwareId, activity: holder.activity }] : [];
    });
    if (conflicts.length > 0) throw executionConflict(conflicts);

    const leaseId = ++this.nextLeaseId;
    const keys = hardwareIds.map((hardwareId) => {
      const generation = (this.generations.get(hardwareId) ?? 0) + 1;
      this.generations.set(hardwareId, generation);
      return { hardwareId, generation };
    });
    const holder: LeaseHolder = { leaseId, activity: normalized, keys };
    this.holders.set(leaseId, holder);
    for (const key of keys) this.hardwareHolders.set(key.hardwareId, { leaseId, generation: key.generation });
    this.notifier?.(this.current());
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.holders.get(leaseId) !== holder) return;
        this.holders.delete(leaseId);
        for (const key of keys) {
          const current = this.hardwareHolders.get(key.hardwareId);
          if (current?.leaseId === leaseId && current.generation === key.generation) this.hardwareHolders.delete(key.hardwareId);
        }
        this.notifier?.(this.current());
      }
    };
  }
}

function normalizeActivity(activity: ActiveExecutionActivity): ActiveExecutionActivity {
  if (activity.state === "manual") return structuredClone(activity);
  return { ...structuredClone(activity), hardwareIds: [...new Set(activity.hardwareIds)].sort(codePointCompare) };
}

function executionConflict(conflicts: { hardwareId: string; activity: ActiveExecutionActivity }[]): Error {
  const hardwareIds = [...new Set(conflicts.map((conflict) => conflict.hardwareId))].sort(codePointCompare);
  const activities = [...new Map(conflicts.map((conflict) => [activityKey(conflict.activity), conflict.activity])).values()].map((activity) => structuredClone(activity));
  return appError("conflict", `Hardware execution is already active for ${hardwareIds.join(", ")}`, { hardwareIds, activities });
}

function activityKey(activity: ActiveExecutionActivity): string {
  return activity.state === "manual" ? `manual:${activity.hardwareId}:${activity.startedAt}` : `run:${activity.runId}`;
}

function compareActivities(left: ActiveExecutionActivity, right: ActiveExecutionActivity): number {
  return left.startedAt.localeCompare(right.startedAt) || activityKey(left).localeCompare(activityKey(right));
}

function codePointCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
