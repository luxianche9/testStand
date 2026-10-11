import { describe, expect, it } from "vitest";
import type { TestResult } from "@teststand/contracts/testing";
import { engineering, resultRows } from "./result-rows.js";

const invoke = (actual: number, passed = true): TestResult => ({
  sequence: 1, at: "", name: "读取 XSP-2 AI0 / VIN6", kind: "verdict", verdict: passed ? "Pass" : "Fail",
  executionId: "e1", hardwareId: "CARD",
  evidence: { assertions: [
    { metric: "result.samples.0.volts", op: "ge", value: -1, actual, passed: actual >= -1 },
    { metric: "result.samples.0.volts", op: "le", value: 1, actual, passed: actual <= 1 }
  ] }
});

describe("resultRows", () => {
  it("reads an invoked tool's judged value and its limits", () => {
    const [row] = resultRows([invoke(-0.013788)]);
    expect(row).toMatchObject({
      verdict: "Pass", value: -0.013788, span: [-0.013788, -0.013788], lower: -1, upper: 1,
      valueText: "-13.79 mV", limitText: "-1 ~ 1 V", executionId: "e1"
    });
    expect(row?.reason).toBeUndefined();
  });

  it("names the failed metric of a failing step", () => {
    const [row] = resultRows([invoke(2.5, false)]);
    expect(row).toMatchObject({ verdict: "Fail", reason: "result.samples.0.volts 超出限值" });
  });

  it("shows a stream window's range with the stream's unit, and why it was inconclusive", () => {
    const unitOf = (hardwareId: string, streamId: string) =>
      hardwareId === "CARD" && streamId === "ai7" ? "V" : "";
    const [pass, unknown] = resultRows([
      {
        sequence: 2, at: "", name: "XSP-2 AI1", kind: "verdict", verdict: "Pass",
        hardwareId: "CARD", streamId: "ai7",
        evidence: {
          metrics: { min: -0.009, max: -0.007, mean: -0.008 },
          assertions: [
            { metric: "min", op: "ge", value: -1, actual: -0.009, passed: true },
            { metric: "max", op: "le", value: 1, actual: -0.007, passed: true }
          ]
        }
      },
      {
        sequence: 3, at: "", name: "XSP-2 AI2", kind: "verdict", verdict: "Inconclusive", streamId: "ai8",
        evidence: { reason: "insufficient_evidence", message: "1 samples in the window, need 2" }
      }
    ], unitOf);
    expect(pass).toMatchObject({
      value: -0.008, span: [-0.009, -0.007], valueText: "-9 m … -7 mV", limitText: "-1 ~ 1 V"
    });
    expect(unknown).toMatchObject({
      verdict: "Inconclusive", valueText: "", reason: "1 samples in the window, need 2"
    });
  });

  it("takes plain assertions and skips results that judge nothing", () => {
    const rows = resultRows([
      { sequence: 4, at: "", name: "电流", kind: "assertion", passed: false, actual: 0.3, unit: "A",
        limits: { minimum: 0, maximum: 0.25 } },
      { sequence: 5, at: "", name: "log", kind: "value", value: 1 }
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: "Fail", valueText: "300 mA", limitText: "0 ~ 250 mA", reason: "超出限值" });
  });

  it("writes engineering notation", () => {
    expect([0, 1500, -0.0000123, 42].map(engineering)).toEqual(["0", "1.5 k", "-12.3 µ", "42"]);
  });
});
