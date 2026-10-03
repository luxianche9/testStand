export type DeviceSelection =
  | { kind: "server"; serverId: string }
  | { kind: "passive"; hardwareId: string }
  | { kind: "none" };

export function parseDeviceSelection(selected: string | null): DeviceSelection {
  if (!selected) return { kind: "none" };
  if (selected.startsWith("s:")) return { kind: "server", serverId: selected.slice(2) };
  if (selected.startsWith("l:")) return { kind: "passive", hardwareId: selected.slice(2) };
  return { kind: "none" };
}
