import { describe, expect, it } from "vitest";
import type { RunMessage } from "@hardwareharness/contracts/observability";
import {
  decodedText, fieldsText, filterMessages, messageFilters, messageIndexAt, messageLabel, spacedHex
} from "./run-messages.js";

const status: RunMessage = {
  alias: "dut", streamId: "dut.status", kind: "message", t: 1, tb: 100, message: "status",
  fields: { selfTest: "pass", voltage: 12.34 }, raw: "aa5504810102d204"
};
const broken: RunMessage = {
  alias: "dut", streamId: "dut.$errors", kind: "error", t: 2, tb: 200, message: "ack", reason: "checksum", raw: "aa55"
};
const unframed: RunMessage = { alias: "dut", streamId: "dut.$unframed", kind: "unframed", t: 3, tb: 300, raw: "ff" };

describe("run messages", () => {
  it("formats the raw and decoded columns", () => {
    expect(spacedHex("aa5504 81")).toBe("AA 55 04 81");
    expect(fieldsText(status.fields)).toBe("selfTest=pass  voltage=12.34");
    expect(decodedText(status)).toBe("selfTest=pass  voltage=12.34");
    expect(decodedText(broken)).toBe("校验失败");
    expect(decodedText({ ...unframed, reason: "too_long" })).toBe("帧过长");
    expect([status, broken, unframed].map(messageLabel)).toEqual(["status", "ack（错误）", "未成帧"]);
  });

  it("filters by message and finds the row at an instant", () => {
    const binding = {
      alias: "dut", icd: "dut_cmd", icdHash: "h", hardwareId: "dev", streamId: "rx", source: "dev__rx",
      recorded: true, messages: ["status", "ack"]
    };
    expect(messageFilters([binding]).map((item) => item.value)).toEqual(["all", "errors", "dut.status", "dut.ack"]);
    const rows = [status, broken, unframed];
    expect(filterMessages(rows, "errors")).toEqual([broken, unframed]);
    expect(filterMessages(rows, "dut.status")).toEqual([status]);
    expect(messageIndexAt(rows, 150)).toBe(1);
    expect(messageIndexAt(rows, 999)).toBe(2);
  });
});
