import type { Hardware } from "@teststand/contracts/devices";
import { describe, expect, it } from "vitest";
import { fallbackHardware, toFlowEdges } from "./flow-elements.js";
import { connectionSignal, portSignal } from "./wiring-model.js";

const port = (name: string, portId = name) => ({ portId, name });

describe("signal classification", () => {
  it.each([
    ["UART1", "bus"],
    ["CAN1", "bus"],
    ["调试串口", "bus"],
    ["USB-C", "link"],
    ["ETH0", "link"],
    ["VCC", "power"],
    ["12V", "power"],
    ["GND1", "ground"],
    ["J1", undefined]
  ] as const)("classifies %s as %s", (name, kind) => {
    expect(portSignal(port(name))).toBe(kind);
  });

  it("agrees when one end is unknown and stays neutral when ends disagree", () => {
    expect(connectionSignal(port("UART0"), port("J3"))).toBe("bus");
    expect(connectionSignal(port("UART0"), port("USB"))).toBeUndefined();
    expect(connectionSignal(undefined, undefined)).toBeUndefined();
  });
});

describe("toFlowEdges", () => {
  const hardware: Hardware[] = [
    { ...fallbackHardware("A", ["UART0", "J1"]) },
    { ...fallbackHardware("B", ["UART1", "J1"]) }
  ];

  it("tags edges with their signal and drops same-port or unresolved connections", () => {
    const edges = toFlowEdges([
      { connectionId: "c1", portA: "A.UART0", portB: "B.UART1" },
      { connectionId: "c2", portA: "A.J1", portB: "A.J1" },
      { connectionId: "c3", portA: "A.J1", portB: "Z.J1" },
      { connectionId: "c4", portA: "A.J1", portB: "B.J1" }
    ], hardware, true);
    expect(edges.map((edge) => edge.id)).toEqual(["c1", "c4"]);
    expect(edges[0]?.className).toBe("wiring-flow-edge signal-bus");
    expect(edges[0]?.data?.signal).toBe("bus");
    expect(edges[1]?.className).toBe("wiring-flow-edge");
  });

  it("makes read-only edges unselectable", () => {
    const [edge] = toFlowEdges([{ connectionId: "c1", portA: "A.J1", portB: "B.J1" }], hardware, false);
    expect(edge?.selectable).toBe(false);
    expect(edge?.focusable).toBe(false);
  });
});
