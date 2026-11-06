import { describe, expect, it } from "vitest";
import { canvasExtent, cells, moved, resized, widgetForStream } from "./canvas-model.js";
import { lit, latestKeys } from "./panels/Widgets.js";

const frame = { x: 2, y: 3, w: 6, h: 4 };

describe("canvas", () => {
  it("snaps drags to the 20 px grid and keeps panels on the canvas", () => {
    expect(cells(29)).toBe(1);
    expect(cells(-40)).toBe(0);
    expect(moved(frame, 41, -9)).toEqual({ x: 4, y: 3, w: 6, h: 4 });
    expect(moved(frame, -500, -500)).toEqual({ x: 0, y: 0, w: 6, h: 4 });
    expect(resized(frame, 30, -200)).toEqual({ x: 2, y: 3, w: 8, h: 2 });
    expect(canvasExtent([frame, { x: 10, y: 0, w: 5, h: 2 }])).toEqual({ width: 460, height: 300 });
  });

  it("makes a fitting widget for a variable dropped on an empty spot", () => {
    expect(widgetForStream("scalar")).toBe("number");
    expect(widgetForStream("bits")).toBe("lamp");
    expect(widgetForStream("bits", { width: 16 })).toBe("digital");
    expect(widgetForStream("block")).toBe("scope");
    expect(widgetForStream("bytes")).toBe("trace");
    expect(widgetForStream(undefined)).toBe("number");
  });

  it("lights a lamp for a value that is not 0, or for one bit of a mask", () => {
    expect(lit(0, undefined)).toBe(false);
    expect(lit(2.5, undefined)).toBe(true);
    expect(lit(0b100, 2)).toBe(true);
    expect(lit(0b100, 1)).toBe(false);
    expect(lit(true, 3)).toBe(true);
    expect(lit(undefined, undefined)).toBeUndefined();
  });

  it("polls the first stream of each small widget once", () => {
    const ref = { hardwareId: "D", streamId: "v" };
    expect(latestKeys([
      { id: "a", type: "number", sources: [ref], settings: {} },
      { id: "b", type: "lamp", sources: [ref], settings: {} },
      { id: "c", type: "scope", sources: [{ hardwareId: "D", streamId: "w" }], settings: {} },
      { id: "d", type: "switch", sources: [], settings: {} }
    ])).toEqual(["D__v"]);
  });
});
