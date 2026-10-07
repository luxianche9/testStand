import type { HardwareSignals, SignalView } from "@teststand/contracts/signals";
import { describe, expect, it } from "vitest";
import {
  catalogOf, defaultPanel, linkProblem, parseHandle, handleId, resolveEnd, widgetSignals
} from "./signal-model.js";

const relay = {
  id: "relay", type: "bits", width: 16, bitLabels: Array.from({ length: 16 }, (_, bit) => `R${bit}`),
  control: [
    { action: "setBit", tool: "pci1762_set_relay", args: {} },
    { action: "setMask", tool: "pci1762_set_bank", args: {} }
  ]
};
const entries: HardwareSignals[] = [
  { hardwareId: "RELAY", label: "PCI-1762", kind: "managed", known: true,
    streams: [{ id: "di", type: "bits", width: 16 }, relay] },
  { hardwareId: "AO", label: "PCI-6208V", kind: "managed", known: true, streams: [
    { id: "ao0", type: "scalar", unit: "V", kind: "setpoint",
      control: [{ action: "set", tool: "set_voltage", args: {} }] },
    { id: "ai0", type: "scalar", unit: "V" }] },
  { hardwareId: "COM", label: "CP-118U", kind: "managed", known: false, streams: [] },
  { hardwareId: "DUT", label: "被测板", kind: "passive", known: true, signals: [
    { signalId: "enable", label: "使能", type: "bits", direction: "input" },
    { signalId: "vref", label: "", type: "scalar", direction: "input" },
    { signalId: "status", label: "", type: "bits", direction: "output", width: 2 }] }
];
const catalog = catalogOf(entries);
const hardware = (nodeId: string, hardwareId: string) =>
  ({ nodeId, kind: "hardware" as const, hardwareId, x: 0, y: 0 });
const widget = (nodeId: string, kind: "scope" | "value" | "lamps" | "switch" | "setpoint" | "terminal") =>
  ({ nodeId, kind: "widget" as const, widget: kind, label: "", config: {}, x: 0, y: 0 });
const base: SignalView = {
  nodes: [hardware("r", "RELAY"), hardware("a", "AO"), hardware("c", "COM"), hardware("d", "DUT"),
    widget("scope", "scope"), widget("value", "value"), widget("sw", "switch"), widget("set", "setpoint")],
  links: []
};
const end = (nodeId: string, handle: string, bit?: number) =>
  ({ nodeId, handle, ...(bit === undefined ? {} : { bit }) });

describe("signal view rules", () => {
  it("lets a device bit carry a 1-bit input and a control drive it through the part", () => {
    const carried: SignalView = {
      ...base, links: [{ linkId: "l1", from: end("r", "relay", 3), to: end("d", "enable") }]
    };
    expect(linkProblem(base, catalog, { from: end("r", "relay", 3), to: end("d", "enable") })).toBeUndefined();
    expect(linkProblem(carried, catalog, { from: end("sw", "out"), to: end("d", "enable") })).toBeUndefined();
    expect(resolveEnd(carried, catalog, end("d", "enable"))).toMatchObject({ key: "RELAY__relay", bit: 3 });
  });

  it.each([
    [{ from: end("r", "relay"), to: end("d", "enable") }, "不能承载"],
    [{ from: end("r", "di", 0), to: end("d", "enable") }, "设备能写的流"],
    [{ from: end("r", "relay"), to: end("a", "ao0") }, "只能把设备的流连到被测对象的信号"],
    [{ from: end("a", "ai0"), to: end("sw", "out") }, "控制控件的输出连到信号"],
    [{ from: end("set", "out"), to: end("a", "ai0") }, "不能写"],
    [{ from: end("r", "relay"), to: end("value", "in") }, "不接受 bits"],
    [{ from: end("r", "relay", 16), to: end("scope", "in") }, "没有第 16 位"],
    [{ from: end("value", "in"), to: end("scope", "in") }, "控件只能连到信号"]
  ])("refuses %o", (link, message) => {
    expect(linkProblem(base, catalog, link)).toContain(message);
  });

  it("refuses a second carrier and a second input on a single-signal widget", () => {
    const view: SignalView = { ...base, links: [
      { linkId: "l1", from: end("r", "relay", 1), to: end("d", "enable") },
      { linkId: "l2", from: end("a", "ai0"), to: end("value", "in") }
    ] };
    expect(linkProblem(view, catalog, { from: end("r", "relay", 2), to: end("d", "enable") })).toContain("已经由另一条流承载");
    expect(linkProblem(view, catalog, { from: end("a", "ao0"), to: end("value", "in") })).toContain("只显示一个信号");
    expect(linkProblem(view, catalog, { from: end("a", "ao0"), to: end("scope", "in") })).toBeUndefined();
  });

  it("does not check streams of a device that was never connected", () => {
    expect(linkProblem(base, catalog, { from: end("c", "serial1"), to: end("scope", "in") })).toBeUndefined();
    expect(resolveEnd(base, catalog, end("c", "serial1"))).toBeUndefined();
  });

  it("labels widget inputs by hardware and bit", () => {
    const view: SignalView = { ...base, links: [{ linkId: "l1", from: end("r", "relay", 2), to: end("scope", "in") }] };
    expect(widgetSignals(view, catalog, "scope").map((item) => item.label)).toEqual(["PCI-1762 · R2"]);
  });

  it("round-trips handle ids", () => {
    expect(parseHandle(handleId("relay", 5))).toEqual({ handle: "relay", bit: 5 });
    expect(parseHandle(handleId("ai0"))).toEqual({ handle: "ai0" });
  });
});

describe("default panel", () => {
  it("places known devices with a widget per stream and one scope for their analog inputs", () => {
    const panel = defaultPanel({ nodes: [], links: [] }, catalog);
    const kinds = panel.nodes.flatMap((node) => node.kind === "widget" ? [node.widget] : [node.hardwareId]);
    expect(kinds).toEqual(["RELAY", "lamps", "switch", "AO", "setpoint", "scope"]);
    for (const link of panel.links) {
      const others = { ...panel, links: panel.links.filter((item) => item !== link) };
      expect(linkProblem(others, catalog, link)).toBeUndefined();
    }
    expect(defaultPanel(panel, catalog).nodes).toHaveLength(panel.nodes.length);
  });
});
