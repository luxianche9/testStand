import { describe, expect, it } from "vitest";
import { itemResult, orderedSelection, summarizeItems, summarySegments } from "./item-status.js";
import { makeItem } from "./testing-api.fixture.js";

describe("item status", () => {
  it("labels each item by its latest run on the current unit", () => {
    expect(itemResult(makeItem("a", "A")).label).toBe("未测");
    expect(itemResult(makeItem("a", "A", { runId: "r", state: "running" })).label).toBe("运行中");
    expect(itemResult(makeItem("a", "A", { queued: true })).label).toBe("排队");
    expect(itemResult(makeItem("a", "A", { runId: "r", state: "completed", verdict: "Pass" })).label).toBe("PASS");
    expect(itemResult(makeItem("a", "A", { runId: "r", state: "completed", verdict: "Fail" })).label).toBe("FAIL");
    expect(itemResult(makeItem("a", "A", { runId: "r", verdict: "Pass", stale: true })).label).toBe("已过期");
  });

  it("summarises PASS / FAIL / 未测 and only lists 已过期 when present", () => {
    const items = [
      makeItem("a", "A", { runId: "r", verdict: "Pass" }),
      makeItem("b", "B", { runId: "r", verdict: "Error" }),
      makeItem("c", "C")
    ];
    const text = (list: typeof items) => summarySegments(summarizeItems(list)).map((item) => item.text).join(" · ");
    expect(text(items)).toBe("1 PASS · 1 FAIL · 1 未测");
    expect(text([...items, makeItem("d", "D", { runId: "r", verdict: "Pass", stale: true })]))
      .toBe("1 PASS · 1 FAIL · 1 已过期 · 1 未测");
  });

  it("returns the selection in list order", () => {
    const items = [makeItem("a", "A"), makeItem("b", "B"), makeItem("c", "C")];
    expect(orderedSelection(items, new Set(["c", "a"]))).toEqual(["a", "c"]);
  });
});
