import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLEANUP_BUDGET_MS,
  DEFAULT_CLEANUP_OPERATOR_TIMEOUT_MS,
  orchestrationSafetyFromEnv
} from "./orchestration-safety.js";

describe("orchestrationSafetyFromEnv", () => {
  it("provides explicit desktop shutdown defaults", () => {
    expect(orchestrationSafetyFromEnv({})).toEqual({
      cleanupBudgetMs: DEFAULT_CLEANUP_BUDGET_MS,
      cleanupOperatorTimeoutMs: DEFAULT_CLEANUP_OPERATOR_TIMEOUT_MS
    });
  });

  it("accepts bounded positive integer overrides", () => {
    expect(orchestrationSafetyFromEnv({
      TESTFORGE_CLEANUP_BUDGET_MS: "20000",
      TESTFORGE_CLEANUP_OPERATOR_TIMEOUT_MS: "4500"
    })).toEqual({ cleanupBudgetMs: 20_000, cleanupOperatorTimeoutMs: 4_500 });
  });

  it("rejects malformed and out-of-range values", () => {
    expect(orchestrationSafetyFromEnv({
      TESTFORGE_CLEANUP_BUDGET_MS: "0",
      TESTFORGE_CLEANUP_OPERATOR_TIMEOUT_MS: "not-a-number"
    })).toEqual({
      cleanupBudgetMs: DEFAULT_CLEANUP_BUDGET_MS,
      cleanupOperatorTimeoutMs: DEFAULT_CLEANUP_OPERATOR_TIMEOUT_MS
    });
  });

  it("never lets a cleanup operator wait beyond the total cleanup budget", () => {
    expect(orchestrationSafetyFromEnv({
      TESTFORGE_CLEANUP_BUDGET_MS: "1000",
      TESTFORGE_CLEANUP_OPERATOR_TIMEOUT_MS: "5000"
    })).toEqual({ cleanupBudgetMs: 1_000, cleanupOperatorTimeoutMs: 1_000 });
  });
});
