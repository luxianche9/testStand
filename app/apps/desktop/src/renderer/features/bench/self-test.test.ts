import { describe, expect, it } from "vitest";
import type { ToolCatalogItem } from "@teststand/contracts/devices";
import { checkValue, selfTestReport, selfTestTool } from "./self-test.js";

const tool = (deviceId: string, remoteName: string) => ({ deviceId, remoteName, externalName: `x__${remoteName}` }) as
  unknown as ToolCatalogItem;

describe("self-test", () => {
  it("finds the device's builtin self_test only", () => {
    const tools = [tool("A", "da6401_write_voltage"), tool("A", "self_test"), tool("B", "self_test")];
    expect(selfTestTool(tools, "A")).toBe(tools[1]);
    expect(selfTestTool([tool("A", "get_device_info")], "A")).toBeUndefined();
    expect(selfTestTool(tools, undefined)).toBeUndefined();
  });

  it("reads the report from the tool envelope", () => {
    const report = selfTestReport({
      structuredContent: {
        ok: true,
        data: {
          passed: false, durationMs: 1203.4, dryRun: false,
          checks: [
            { name: "板卡类型", passed: true, measured: "0x3210", expected: "0x3210", detail: "dwCardType" },
            { name: "AI 实际采样率", passed: false, measured: 812.25, expected: "950..1050 Hz" }
          ]
        }
      }
    });
    expect(report?.passed).toBe(false);
    expect(report?.durationMs).toBe(1203.4);
    expect(report?.checks.map((check) => [check.name, check.passed, check.measured])).toEqual([
      ["板卡类型", true, "0x3210"], ["AI 实际采样率", false, "812.25"]
    ]);
    expect(selfTestReport({ ok: true, data: { mask: 1 } })).toBeUndefined();
  });

  it("formats values on one line", () => {
    expect(checkValue(1 / 3)).toBe("0.333333");
    expect(checkValue([])).toBe("[]");
    expect(checkValue({ max: 54, relay: 0 })).toBe('{"max":54,"relay":0}');
    expect(checkValue(null)).toBe("");
    expect(checkValue(true)).toBe("是");
  });
});
