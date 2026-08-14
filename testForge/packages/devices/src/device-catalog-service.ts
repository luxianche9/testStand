import type { Hardware, HardwarePort } from "@testforge/contracts/devices";
import type { PinPair } from "@testforge/contracts/wiring";
import type { DeviceStore } from "./device-store.js";

/**
 * Read/write access to the hand-authored hardware library, plus the checks wiring depends on.
 *
 * There is deliberately no path here that asks an MCP Server what its pins are. A Server implements
 * the vendor SDK and nothing else; ports, pins and images are authored in Device Management and
 * stored locally, which is also why a device can be registered while its remote is unreachable.
 */
export class DeviceCatalogService {
  constructor(readonly store: DeviceStore) {}

  listHardware(): Hardware[] { return this.store.listHardware(); }

  getHardware(hardwareId: string): Hardware {
    return this.store.requireHardware(hardwareId);
  }

  findHardware(hardwareId: string): Hardware | undefined { return this.store.getHardware(hardwareId); }

  saveHardware(input: Hardware): Promise<Hardware> { return this.store.saveHardware(input); }

  removeHardware(hardwareId: string): Promise<void> { return this.store.removeHardware(hardwareId); }

  hardwareForServer(serverId: string): Hardware | undefined {
    return this.listHardware().find((item) => item.kind === "managed" && item.serverId === serverId);
  }

  /**
   * Resolve `<hardwareId>.<portId>`. Hardware ids are matched longest-first so `DUT_1` can never
   * shadow `DUT_10`; the remainder is the portId, which may itself contain dots.
   */
  resolvePort(portRef: string): { hardware: Hardware; port: HardwarePort } {
    const candidates = [...this.listHardware()].sort((a, b) => b.hardwareId.length - a.hardwareId.length);
    for (const hardware of candidates) {
      if (!portRef.startsWith(`${hardware.hardwareId}.`)) continue;
      const portId = portRef.slice(hardware.hardwareId.length + 1);
      const port = hardware.ports.find((item) => item.portId === portId);
      if (port) return { hardware, port };
      throw new Error(`Hardware ${hardware.hardwareId} has no port ${portId}`);
    }
    throw new Error(`No hardware matches port reference ${portRef}`);
  }

  /** Every pin pair must name a pin that actually exists on its side. Counts may differ: a partial
   *  harness and a crossover cable are both legitimate, which is why the mapping is explicit. */
  validatePins(portA: string, portB: string, pins: PinPair[]): void {
    const a = this.resolvePort(portA);
    const b = this.resolvePort(portB);
    const known = (port: HardwarePort) => new Set(port.pins.map((pin) => pin.pinId));
    const knownA = known(a.port);
    const knownB = known(b.port);
    const seen = new Set<string>();
    for (const pair of pins) {
      if (!knownA.has(pair.a)) throw new Error(`Port ${portA} has no pin ${pair.a}`);
      if (!knownB.has(pair.b)) throw new Error(`Port ${portB} has no pin ${pair.b}`);
      const key = JSON.stringify([pair.a, pair.b]);
      if (seen.has(key)) throw new Error(`Duplicate pin pair ${pair.a} - ${pair.b}`);
      seen.add(key);
    }
  }

  /** Operators work from the port photo plus the printed pin number, so a missing photo is a
   *  warning on the todo rather than a reason to refuse it. */
  warningsForPorts(portA: string, portB: string): string[] {
    return [portA, portB].flatMap((portRef) => {
      try {
        const { hardware, port } = this.resolvePort(portRef);
        return port.imageAssetId ? [] : [`${hardware.label} 的端口 ${port.name} 还没有上传端口图`];
      } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
      }
    });
  }
}
