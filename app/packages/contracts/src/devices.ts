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
  mode: z.enum(["real", "sim"]).default("real"),
  enabled: z.boolean().default(true)
}).strict();
export type DeviceInstance = z.infer<typeof deviceInstanceSchema>;
/** An installed device plugin type (`devices.listDeviceTypes`); `error` when it cannot be loaded. */
export interface DeviceType {
  type: string;
  manufacturer?: string;
  model?: string;
  isolation?: "inproc" | "subprocess";
  description?: string;
  /** Adapter distribution version. */
  version?: string;
  /** `package`: installed from a `.tsdev` file; `builtin`: shipped in the backend environment. */
  source?: "builtin" | "package";
  error?: string;
}

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

/** What installing a `.tsdev` would do (`devices.inspectPackage`); nothing is written. */
export interface DevicePackageInspection {
  manifest: DevicePackageManifest;
  sha256: string;
  size: number;
  /** `skipped`: a dependency testStand already ships; its own copy is used instead. */
  files: { name: string; size: number; sha256: string; skipped: boolean }[];
  action: "install" | "upgrade" | "reinstall";
  installedVersion: string | null;
  restartRequired: boolean;
  /** Reasons it cannot be installed here; empty when it can. */
  problems: string[];
}

/** An installed device package (`devices.listPackages`). */
export interface InstalledDevicePackage {
  type: string;
  version: string;
  distribution: string;
  manufacturer: string;
  model: string;
  isolation: "inproc" | "subprocess";
  description: string;
  vendorDrivers: string[];
  sha256: string;
  installedAt: string;
  /** False until the next start when this is an install waiting to replace nothing. */
  active: boolean;
  /** A change that takes effect at the next start of testStand. */
  pending?: { action: "install"; version: string } | { action: "uninstall" };
}

export interface DevicePackageChange {
  type: string;
  version?: string;
  action?: "install" | "upgrade" | "reinstall";
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

const hardwareFields = {
  hardwareId: z.string().min(1),
  label: z.string().min(1),
  ports: z.array(hardwarePortSchema).default([])
};
export const storedHardwareDefinitionSchema = z.object({ formatVersion: z.literal(2).default(2), ...hardwareFields });
export type StoredHardwareDefinition = z.infer<typeof storedHardwareDefinitionSchema>;

export const hardwareSchema = z.object({
  formatVersion: z.literal(2).default(2),
  hardwareId: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["managed", "passive"]),
  deviceId: z.string().min(1).optional(),
  ports: z.array(hardwarePortSchema).default([])
}).superRefine((value, context) => {
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
    dryRun?: boolean;
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
