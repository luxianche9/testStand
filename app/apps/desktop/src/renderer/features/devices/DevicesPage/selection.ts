export type DeviceSelection =
  | { kind: "device"; deviceId: string }
  | { kind: "passive"; hardwareId: string }
  | { kind: "none" };

export function parseDeviceSelection(selected: string | null): DeviceSelection {
  if (!selected) return { kind: "none" };
  if (selected.startsWith("s:")) return { kind: "device", deviceId: selected.slice(2) };
  if (selected.startsWith("l:")) return { kind: "passive", hardwareId: selected.slice(2) };
  return { kind: "none" };
}
