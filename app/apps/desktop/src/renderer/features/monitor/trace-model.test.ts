import { describe, expect, it } from "vitest";
import {
  changedBytes, decodedRows, filterRows, fixedRows, previousBytes, recordRows, type TraceRow
} from "./trace-model.js";

const row = (tb: number, ident: string, bytes: number[], dir = "rx"): TraceRow =>
  ({ uid: `k#${tb}`, key: "k", streamId: "can0", tb, dir, ident, bytes });

describe("bus trace model", () => {
  it("turns frames records into rows", () => {
    expect(recordRows("k", "can0", [{ i: 7, t: 1, tb: 1000, dir: "tx", id: 0x81, data: "aa55" }])).toEqual([
      { uid: "k#7", key: "k", streamId: "can0", tb: 1000, dir: "tx", ident: "0x81", bytes: [0xaa, 0x55] }
    ]);
  });

  it("keeps one row per identity with count, period and the bytes before", () => {
    const rows = [row(0, "0x1", [1, 2]), row(10, "0x2", [9]), row(20, "0x1", [1, 3]), row(40, "0x1", [1, 4])];
    const fixed = fixedRows(rows);
    expect(fixed.map((item) => [item.ident, item.count, item.periodMs, item.bytes, item.previous])).toEqual([
      ["0x1", 3, 20, [1, 4], [1, 3]],
      ["0x2", 1, undefined, [9], undefined]
    ]);
    expect(changedBytes([1, 3], [1, 4])).toEqual([false, true]);
    expect(changedBytes(undefined, [1])).toEqual([false]);
    expect(previousBytes(rows).get("k#20")).toEqual([1, 2]);
  });

  it("filters by column, ignoring case and spaces in data", () => {
    const rows = [row(0, "0x81", [0xaa, 0x55]), row(1, "0x82", [0x01]), row(2, "0x81", [0x55], "tx")];
    expect(filterRows(rows, { ident: "0x81", data: "aa 5" }).map((item) => item.tb)).toEqual([0]);
    expect(filterRows(rows, { dir: "TX" }).map((item) => item.tb)).toEqual([2]);
    expect(filterRows(rows, { dir: " " })).toHaveLength(3);
  });

  it("maps decoded frames back to the time of the record that completed them", () => {
    const rows = decodedRows("k", "serial1", {
      "dut.status": [{ seq: 4, dir: "rx", message: "status", fields: { voltage: 5 }, raw: "aa5506", checksumOk: true }],
      "dut.status.voltage": [{ seq: 4, v: 5 }],
      "dut.$errors": [{ seq: 5, reason: "checksum", raw: "aa" }]
    }, (seq) => ({ 4: 100, 5: 200 } as Record<number, number>)[seq]);
    expect(rows.map((item) => [item.tb, item.ident, item.fields, item.problem])).toEqual([
      [100, "status", { voltage: 5 }, undefined],
      [200, "$errors", undefined, "checksum"]
    ]);
  });
});
