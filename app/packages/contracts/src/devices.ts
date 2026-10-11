import { z } from "zod";

export const connectionStateSchema = z.enum(["unknown", "checking", "online", "offline", "error"]);
export type ConnectionState = z.infer<typeof connectionStateSchema>;

/** A device plugin loaded into the backend: `type` names its `teststand.devices` entry point. */
export const deviceInstanceSchema = z.object({
  deviceId: z.string().min(1),
  label: z.string().min(1),
  hardwareId: z.string().min(1),
  type: z.string().min(1),
  settings: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true)
}).strict();
export type DeviceInstance = z.infer<typeof deviceInstanceSchema>;
/** The manifest (`package.json`) of a `.tsdev` device package. */
export interface DevicePackageManifest {
  formatVersion: 1;
  kind: "devicePlugin";
  type: string;
  distribution: string;
  version: string;
  manufacturer: string;
  model: string;
  isolation: "inproc" | "subprocess";
  description: string;
  sdk: string;
  vendorDrivers: string[];
  files: Record<string, string>;
  builtAt?: string;
}

/** What adding a device from a `.tsdev` would install (`devices.inspectPackage`); nothing is written.
 *  `present`: the driver is already here, nothing is installed. */
export interface DevicePackageInspection {
  manifest: DevicePackageManifest;
  sha256: string;
  size: number;
  /** `skipped`: a dependency testStand already ships; its own copy is used instead. */
  files: { name: string; size: number; sha256: string; skipped: boolean }[];
  action: "install" | "upgrade" | "reinstall" | "present";
  installedVersion: string | null;
  restartRequired: boolean;
  /** Reasons it cannot be installed here; empty when it can. */
  problems: string[];
}

/** `devices.addDevice`: the new device, its first connection attempt, and whether testStand must
 *  restart because a newer driver replaced one already loaded. */
export interface DeviceAdded {
  device: DeviceInstance;
  status: DeviceStatus;
  restartRequired: boolean;
}
/** `devices.updatePackageFromFile`: a newer driver for an installed device type; its devices
 *  (`devices`) use it once testStand restarts when `restartRequired`. */
export interface DevicePackageUpdated {
  type: string;
  version: string;
  action: DevicePackageInspection["action"];
  devices: string[];
  restartRequired: boolean;
}

/** One installed device package (`devices.listPackages`); `pending` is applied at the next start. */
export interface InstalledDevicePackage {
  type: string;
  version: string;
  manufacturer: string;
  model: string;
  active: boolean;
  pending?: { action: "install"; version: string } | { action: "uninstall" };
}
export interface DevicePackages {
  packages: InstalledDevicePackage[];
  /** A package change waits for testStand to restart. */
  restartRequired: boolean;
}
export type StoredDevice = DeviceInstance;
export const deviceIdInputSchema = z.object({ id: z.string().min(1) }).strict();

export interface ConnectionStatus { state: ConnectionState; checkedAt?: string; message?: string }
export interface DeviceStatus { deviceId: string; transport: ConnectionStatus }

export type HardwareState = "initializing" | "open" | "unreachable" | "faulted" | "closing" | "closed";
export const managedHardwareSchema = z.object({
  hardwareId: z.string().min(1),
  deviceId: z.string().min(1),
  state: z.enum(["initializing", "open", "unreachable", "faulted", "closing", "closed"]),
  health: z.string(),
  // Python datetime.isoformat() reports UTC as +00:00 and may include microseconds.
  lastError: z.object({ category: z.string().min(1), message: z.string(), at: z.string().datetime({ offset: true }).optional() }).nullable().optional()
});
export type ManagedHardware = z.infer<typeof managedHardwareSchema>;
export const reportedManagedHardwareSchema = managedHardwareSchema.omit({ deviceId: true });
export interface ToolCatalogItem {
  externalName: string;
  remoteName: string;
  deviceId: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  kind: string;
  /** The plugin's declared semantics: `actuate` changes outputs, `read` only reads, `safe` drives
   *  outputs to their safe values. */
  contractMetadata?: { operationSemantics?: { kind?: string } };
}

export const hardwarePinSchema = z.object({
  pinId: z.string().min(1),
  position: z.number().int().min(1),
  label: z.string().default("")
});
export type HardwarePin = z.infer<typeof hardwarePinSchema>;

export const hardwarePortSchema = z.object({
  portId: z.string().min(1),
  name: z.string().min(1),
  pins: z.array(hardwarePinSchema).default([])
});
export type HardwarePort = z.infer<typeof hardwarePortSchema>;

/** A signal a passive part (a unit under test, a fixture) declares: its logical interface, never a
 *  pin. A device's signals are the streams its plugin declares, so only passive parts store them. */
export const hardwareSignalSchema = z.object({
  signalId: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  label: z.string().default(""),
  type: z.enum(["scalar", "bits", "bytes", "frames"]),
  /** From the part's side: input (driven by a device), output (measured), bidirectional (a bus). */
  direction: z.enum(["input", "output", "bidirectional"]),
  unit: z.string().min(1).optional(),
  width: z.number().int().min(1).max(64).optional(),
  bitLabels: z.array(z.string()).optional()
});
export type HardwareSignal = z.infer<typeof hardwareSignalSchema>;

const hardwareFields = {
  hardwareId: z.string().min(1),
  label: z.string().min(1),
  ports: z.array(hardwarePortSchema).default([]),
  signals: z.array(hardwareSignalSchema).default([])
};
export const storedHardwareDefinitionSchema = z.object({ formatVersion: z.literal(2).default(2), ...hardwareFields });
export type StoredHardwareDefinition = z.infer<typeof storedHardwareDefinitionSchema>;

export const hardwareSchema = z.object({
  formatVersion: z.literal(2).default(2),
  hardwareId: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["managed", "passive"]),
  deviceId: z.string().min(1).optional(),
  ports: z.array(hardwarePortSchema).default([]),
  signals: z.array(hardwareSignalSchema).default([])
}).superRefine((value, context) => {
  if (value.kind === "managed" && value.signals.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "A device's signals are its plugin's streams; only passive parts declare signals" });
  const signalIds = new Set<string>();
  for (const signal of value.signals) {
    if (signalIds.has(signal.signalId)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate signalId: ${signal.signalId}` });
    signalIds.add(signal.signalId);
    if (signal.bitLabels && signal.bitLabels.length !== (signal.width ?? 1)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Signal ${signal.signalId}: bitLabels needs one label per bit` });
    if (signal.type !== "bits" && (signal.width !== undefined || signal.bitLabels)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Signal ${signal.signalId}: width and bitLabels are for bits signals` });
  }
  if (value.kind === "managed" && !value.deviceId) context.addIssue({ code: z.ZodIssueCode.custom, message: "Managed hardware requires deviceId" });
  if (value.kind === "passive" && value.deviceId) context.addIssue({ code: z.ZodIssueCode.custom, message: "Passive hardware cannot reference a device instance" });
  const portIds = new Set<string>();
  for (const port of value.ports) {
    if (portIds.has(port.portId)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate portId: ${port.portId}` });
    portIds.add(port.portId);
    const pinIds = new Set<string>();
    for (const pin of port.pins) {
      if (pinIds.has(pin.pinId)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate pinId ${pin.pinId} in port ${port.portId}` });
      pinIds.add(pin.pinId);
    }
  }
});
export type Hardware = z.infer<typeof hardwareSchema>;
export const hardwareIdInputSchema = z.object({ id: z.string().min(1) }).strict();
export type HardwareAvailabilityState = "checking" | "available" | "unavailable" | "faulted";
export interface HardwareAvailability {
  hardwareId: string;
  state: HardwareAvailabilityState;
  checkedAt: string;
  message?: string;
}

export const deviceBundleKindSchema = z.literal("hardware");
export type DeviceBundleKind = z.infer<typeof deviceBundleKindSchema>;
export const deviceBundleIdInputSchema = z.object({ id: z.string().min(1) }).strict();
export interface DeviceBundleExport { path: string; kind: "hardware"; id: string }
export interface DeviceBundleImport { kind: "hardware"; id: string; label: string; replaced: boolean }
export interface DeviceBundlePreview { kind: "hardware"; hardware: StoredHardwareDefinition; data: Uint8Array }
export const deviceBundleApplyInputSchema = z.object({
  kind: deviceBundleKindSchema,
  hardwareId: z.string().min(1),
  deviceId: z.string().min(1),
  data: z.custom<Uint8Array<ArrayBufferLike>>((value) => value instanceof Uint8Array, "Expected Uint8Array")
}).strict();
export type DeviceBundleApplyInput = z.infer<typeof deviceBundleApplyInputSchema>;

/** A managed device's own declaration (`GET /device`), as the terminal last cached it (§9.7). */
export interface DeviceDeclaredPinFunction { signal: string; direction: string; electricalType: string; channelKind?: string; channelIndex?: number; mode?: string; description?: string }
export interface DeviceDeclaredPin { pinId: string; connectorId: string; position: number | string; functions: DeviceDeclaredPinFunction[] }
export interface DeviceDeclaredConnector {
  connectorId: string;
  name: string;
  connectorType: string;
  gender?: string;
  channelIndex?: number;
  pinIds: string[];
}
export interface DeviceDeclaration {
  manifestRevision: string;
  contractRevision?: string;
  identity: {
    deviceId: string;
    hardwareId: string;
    manufacturer?: string;
    model?: string;
    hardwareRevision?: string;
    adapter?: { name: string; version: string };
    sdkVersion?: string;
  };
  description?: string;
  pinout?: { connectors: DeviceDeclaredConnector[]; pins: DeviceDeclaredPin[]; activeMode?: string; modes?: unknown; hardwareRevision?: string } | null;
  streams?: Record<string, unknown>[];
  capabilities?: Record<string, unknown>;
  tools?: { name: string; kind: string }[];
}
export interface ManagedDeviceDefinition {
  hardwareId: string;
  manifestRevision: string;
  fetchedAt: string;
  /** The service is not reachable now: this is the cached copy. */
  offline: boolean;
  document: DeviceDeclaration;
}
