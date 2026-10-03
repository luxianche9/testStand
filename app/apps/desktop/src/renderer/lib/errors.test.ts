import { describe, expect, it } from "vitest";
import { appError } from "@teststand/contracts/errors";
import { errorCategoryMessage, errorMessage } from "./errors.js";

describe("renderer error messages", () => {
  it("maps categorized application errors to user-facing Chinese copy", () => {
    expect(errorMessage(appError("requires_project", "Project required"))).toBe("请先打开一个工程");
    expect(errorMessage(appError("safe_stop_failed", "Safe stop failed"))).toBe("设备未能安全停止，请立即检查现场状态");
  });

  it("retains the original message for generic and uncategorized errors", () => {
    expect(errorMessage(appError("error", "Detailed failure"))).toBe("Detailed failure");
    expect(errorMessage(new Error("Network detail"))).toBe("Network detail");
  });

  it("exposes category copy for detailed error views", () => {
    expect(errorCategoryMessage("assertion_failed")).toBe("断言未通过");
    expect(errorCategoryMessage("error")).toBeUndefined();
  });
});
