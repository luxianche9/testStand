export const DEFAULT_CLEANUP_BUDGET_MS = 15_000;
export const DEFAULT_CLEANUP_OPERATOR_TIMEOUT_MS = 3_000;

const CLEANUP_BUDGET_RANGE = { min: 1_000, max: 120_000 } as const;
const CLEANUP_OPERATOR_TIMEOUT_RANGE = { min: 250, max: 30_000 } as const;

export function orchestrationSafetyFromEnv(env: Readonly<Record<string, string | undefined>>): {
  cleanupBudgetMs: number;
  cleanupOperatorTimeoutMs: number;
} {
  const cleanupBudgetMs = boundedInteger(
    env.TESTFORGE_CLEANUP_BUDGET_MS,
    DEFAULT_CLEANUP_BUDGET_MS,
    CLEANUP_BUDGET_RANGE.min,
    CLEANUP_BUDGET_RANGE.max
  );
  const cleanupOperatorTimeoutMs = Math.min(cleanupBudgetMs, boundedInteger(
    env.TESTFORGE_CLEANUP_OPERATOR_TIMEOUT_MS,
    DEFAULT_CLEANUP_OPERATOR_TIMEOUT_MS,
    CLEANUP_OPERATOR_TIMEOUT_RANGE.min,
    CLEANUP_OPERATOR_TIMEOUT_RANGE.max
  ));
  return { cleanupBudgetMs, cleanupOperatorTimeoutMs };
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
