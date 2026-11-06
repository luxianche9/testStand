import { describe, expect, it } from "vitest";
import {
  addMessageFor, bytesValue, defineField, enumText, fieldDraft, fieldSpan, guessHeader, hexBytes, matchOn, newIcdDoc,
  parseEnum, suggestType
} from "./icd-document.js";
import { readings } from "./ByteInspector.js";

describe("ICD document", () => {
  it("suggests a type for the number of picked bytes", () => {
    expect([1, 2, 3, 4, 8].map(suggestType)).toEqual(["u8", "u16", "bytes", "u32", "u64"]);
  });

  it("places fields in a frame, counting negative offsets from its end", () => {
    expect(fieldSpan({ name: "a", offset: 4, type: "u16" }, 10)).toEqual({ start: 4, end: 6 });
    expect(fieldSpan({ name: "crc", offset: -2, type: "u16" }, 10)).toEqual({ start: 8, end: 10 });
    expect(fieldSpan({ name: "v", offset: 2, type: "ascii", length: 3 }, 10)).toEqual({ start: 2, end: 5 });
    expect(fieldSpan({ name: "p", expr: "a * 2" }, 10)).toBeUndefined();
  });

  it("defines a field from picked bytes, in byte order and under an unused name", () => {
    const doc = newIcdDoc("dut");
    const draft = fieldDraft(doc.messages[0], 6, 2);
    expect(draft).toEqual({ name: "field6", type: "u16", endian: "big" });
    const first = defineField(doc, 0, 6, 2, { ...draft, scale: 0.01, unit: "V" });
    const second = defineField(first, 0, 4, 3, { name: "tag", type: "bytes", endian: "big" });
    expect(second.messages[0]?.fields).toEqual([
      { name: "tag", offset: 4, type: "bytes", endian: "big", length: 3 },
      { name: "field6", offset: 6, type: "u16", endian: "big", scale: 0.01, unit: "V" }
    ]);
    expect(fieldDraft(second.messages[0], 6, 1).name).toBe("field62");
    expect(doc.messages[0]?.fields).toEqual([]);
  });

  it("tells messages apart by picked bytes", () => {
    const message = { name: "a", match: [{ offset: 3, value: 1 }, { length: 9 }], fields: [] };
    const doc = { ...newIcdDoc("dut"), messages: [message] };
    expect(matchOn(doc, 0, 3, [0x81]).messages[0]?.match).toEqual([
      { offset: 3, value: 0x81, size: 1, endian: "big" }, { length: 9 }
    ]);
    const [added, index] = addMessageFor(doc, 2, [0x10, 0x01]);
    expect(index).toBe(1);
    expect(added.messages[1]).toEqual({
      name: "msg_1001", description: null, match: [{ offset: 2, value: 0x1001, size: 2 }], fields: []
    });
    expect(bytesValue([0x01, 0x02], "little")).toBe(0x0201);
  });

  it("guesses the header every sample starts with", () => {
    expect(guessHeader(["AA 55 05 01", "aa5507 02", "AA 55 00"])).toBe("AA 55");
    expect(guessHeader(["AA 55 05", "BB 55 05"])).toBeUndefined();
    expect(guessHeader(["AA 55 05"])).toBeUndefined();
  });

  it("reads enums, hex and byte values", () => {
    expect(parseEnum("0=fail, 1：pass")).toEqual({ 0: "fail", 1: "pass" });
    expect(parseEnum("")).toBeNull();
    expect(parseEnum("on")).toBeUndefined();
    expect(enumText({ 0: "关", 1: "开" })).toBe("0=关, 1=开");
    expect(hexBytes("AA 55 0x01")).toEqual([0xaa, 0x55, 0x01]);
    expect(hexBytes("A")).toBeUndefined();
    expect(readings([0x09, 0xe2])).toEqual(["无符号 大端 2530", "小端 57865", "有符号 大端 2530 / 小端 -7671"]);
    expect(readings([0x41, 0x20, 0x00, 0x00]).at(-1)).toBe("浮点 大端 10 / 小端 1.157052e-41");
  });
});
