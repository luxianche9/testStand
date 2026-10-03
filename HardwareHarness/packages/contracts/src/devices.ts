import { z } from "zod";

export const connectionStateSchema = z.enum(["unknown", "checking", "online", "offline", "error"]);
export type ConnectionState = z.infer<typeof connectionStateSchema>;

/** A device plugin loaded into the backend: `type` names its `hardwareharness.devices` entry point. */
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
  error?: string;
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

/** Adapter release (design doc §8.4): "developing" until every release gate is met. */
export const adapterStatusSchema = z.enum(["developing", "available"]);
export type AdapterStatus = z.infer<typeof adapterStatusSchema>;
export type AdapterReleaseGate = "check" | "simulator" | "smoke";
export interface AdapterEvidence { at: string; note: string }
/** A manual bench smoke run: who ran it, the wiring used and what they observed. */
export interface AdapterSmokeRecord { operator: string; at: string; wiring: string; observation: string }
export interface AdapterReleaseRecord {
  hardwareId: string;
  status: AdapterStatus;
  check?: AdapterEvidence;
  simulator?: AdapterEvidence;
  smoke: AdapterSmokeRecord[];
  /** Release gates not met yet; "available" needs this empty. */
  gaps: AdapterReleaseGate[];
}

export const hardwareSchema = z.object({
  formatVersion: z.literal(2).default(2),
  hardwareId: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["managed", "passive"]),
  deviceId: z.string().min(1).optional(),
  ports: z.array(hardwarePortSchema).default([]),
  /** Managed hardware only, derived by the backend from the adapter record. */
  adapterStatus: adapterStatusSchema.optional()
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
