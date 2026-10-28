import { describe, expect, it } from "vitest";
import { bindingIssues, nextAlias, parseSamples, sampleIssue, trialRows } from "./protocol-bindings.js";

const source = { hardwareId: "dev", streamId: "uart" };

describe("protocol bindings", () => {
  it("flags bad and duplicate aliases and missing sources", () => {
    expect(bindingIssues([
      { icd: "a", alias: "dut", source },
      { icd: "a", alias: "dut", source },
      { icd: "a", alias: "1x", source },
      { icd: "a", alias: "ok", source: { hardwareId: "dev", streamId: "" } },
      { icd: "a", alias: "fine", source }
    ])).toEqual([
      "别名 dut 重复", "别名 dut 重复", expect.stringContaining("别名只能"), "选择原始数据流", undefined
    ]);
  });

  it("picks an unused alias from the ICD name", () => {
    expect(nextAlias([], "dut_ack")).toBe("dut_ack");
    expect(nextAlias([{ icd: "x", alias: "dut", source }], "x-y")).toBe("dut2");
  });

  it("parses hex sample lines and reports broken ones", () => {
    const samples = parseSamples("AA 55 02  # header\n\n01 07\nzz");
    expect(samples).toEqual(["AA5502", "0107", "zz"]);
    expect(sampleIssue(samples)).toBe("第 3 段不是完整的十六进制字节");
    expect(sampleIssue(samples.slice(0, 2))).toBeUndefined();
  });

  it("lists trial-decoded messages before their fields and marks failures", () => {
    expect(trialRows({
      "dut.ack.code": [{ t: 0, tb: 0, seq: 0, v: 7 }],
      "dut.ack": [{ t: 0, seq: 1, fields: { code: 7, mode: "run" }, raw: "aa55" }],
      "dut.$errors": [{ t: 0, seq: 0, reason: "checksum", message: "ack", fields: { code: 9 }, raw: "aa00" }],
      "dut.$unframed": [{ t: 0, data: "ff", reason: "no_header" }]
    }, new Map([["dut.ack.code", "V"]]))).toEqual([
      { sample: 1, label: "错误帧", text: "校验失败 （ack） code=9", failed: true, raw: "aa00" },
      { sample: 2, label: "ack", text: "code=7 V  mode=run", failed: false, raw: "aa55" },
      { sample: undefined, label: "未成帧", text: "找不到帧头", failed: true, raw: "ff" }
    ]);
  });
});
