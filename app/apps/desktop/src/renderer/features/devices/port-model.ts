import type { HardwarePort } from "@teststand/contracts/devices";

/** Ports and pins are identified by hand-typed ids, so a new row only needs a free default. */
export function uniqueId(prefix: string, taken: Set<string>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `${prefix}${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Positions describe physical order, so they stay contiguous when a pin in the middle goes. */
function renumber(pins: HardwarePort["pins"]): HardwarePort["pins"] {
  return pins.map((pin, index) => ({ ...pin, position: index + 1 }));
}

export function addPin(port: HardwarePort): HardwarePort {
  const pinId = uniqueId("", new Set(port.pins.map((entry) => entry.pinId)));
  return { ...port, pins: [...port.pins, { pinId, position: port.pins.length + 1, label: "" }] };
}

export function removePin(port: HardwarePort, pinId: string): HardwarePort {
  return { ...port, pins: renumber(port.pins.filter((entry) => entry.pinId !== pinId)) };
}

export function updatePin(
  port: HardwarePort,
  pinId: string,
  change: Partial<Pick<HardwarePort["pins"][number], "pinId" | "label">>
): HardwarePort {
  return { ...port, pins: port.pins.map((entry) => (entry.pinId === pinId ? { ...entry, ...change } : entry)) };
}

export function pinTotal(ports: HardwarePort[]): number {
  return ports.reduce((total, port) => total + port.pins.length, 0);
}
