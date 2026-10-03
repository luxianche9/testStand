import type { Hardware, HardwarePin, HardwarePort, McpServerConfig } from "@hardwareharness/contracts/devices";

/**
 * Wiring references a port as `<hardwareId>.<portId>` and a pin by its port-local id. Profile and
 * endpoint used to be separate records with different id prefixes, which is why this file once had
 * to translate between them; one merged Hardware record leaves nothing to translate.
 */
/** Longest hardwareId first, so `DUT_1` never shadows `DUT_10`. */
export function resolvePortRef(ref: string, hardware: Hardware[]): { hardware?: Hardware; port?: HardwarePort } {
  const owner = [...hardware].sort((a, b) => b.hardwareId.length - a.hardwareId.length)
    .find((item) => ref.startsWith(`${item.hardwareId}.`));
  if (!owner) return {};
  const port = owner.ports.find((item) => item.portId === ref.slice(owner.hardwareId.length + 1));
  return port ? { hardware: owner, port } : { hardware: owner };
}

export function hardwareForServer(server: McpServerConfig, hardware: Hardware[]): Hardware | undefined {
  return hardware.find((item) => item.hardwareId === server.hardwareId);
}

/** Human-readable port label used in wiring lists, task cards and connection drawers. */
export function portLabel(ref: string, hardware: Hardware[]): string {
  const resolved = resolvePortRef(ref, hardware);
  if (!resolved.hardware) return ref;
  if (!resolved.port) return `${resolved.hardware.label} · ${ref}`;
  return `${resolved.hardware.label} ${resolved.port.name}`;
}

function findPin(port: HardwarePort | undefined, pinId: string): HardwarePin | undefined {
  return port?.pins.find((item) => item.pinId === pinId);
}

/** `1 (TX)` when the pin carries a signal name, just `1` when it does not. */
export function pinText(port: HardwarePort | undefined, pinId: string): string {
  const pin = findPin(port, pinId);
  if (!pin) return pinId;
  return pin.label ? `${pin.pinId} (${pin.label})` : pin.pinId;
}
