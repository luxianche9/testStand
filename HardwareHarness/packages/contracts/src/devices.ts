import { z } from "zod";

export const connectionStateSchema = z.enum(["unknown", "checking", "online", "offline", "error"]);
export type ConnectionState = z.infer<typeof connectionStateSchema>;

export const remoteComputerSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  address: z.string().min(1),
  // Existing records remain SSH hosts. Local lifecycle execution must be explicit.
  execution: z.enum(["ssh", "local"]).optional(),
  ssh: z.object({
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().min(1),
    hostKeyFingerprint: z.string().optional(),
    shell: z.enum(["powershell", "posix"]).default("powershell")
  })
}).superRefine((value, context) => {
  if (value.execution === "local" && !["127.0.0.1", "localhost", "::1"].includes(value.address)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["address"], message: "Local computers require a loopback address" });
  }
});
export type RemoteComputer = z.infer<typeof remoteComputerSchema>;
export type StoredRemoteComputer = RemoteComputer;
export const computerIdInputSchema = z.object({ id: z.string().min(1) }).strict();

// Overrides for single commands; by default every command derives from `root` (design doc §4.8.2).
const serverLifecycleSchema = z.object({
  statusCommand: z.string().min(1).optional(),
  startCommand: z.string().min(1).optional(),
  stopCommand: z.string().min(1).optional(),
  forceStopCommand: z.string().min(1).optional(),
  logPath: z.string().min(1).optional()
}).strict();
export type ServerLifecycle = z.infer<typeof serverLifecycleSchema>;

export const mcpHttpServerSchema = z.object({
  transport: z.literal("mcp-http"),
  serverId: z.string().min(1),
  // Absent: an unmanaged service added by URL + token; usable, but not started or stopped.
  computerId: z.string().min(1).optional(),
  label: z.string().min(1),
  hardwareId: z.string().min(1),
  url: z.string().url(),
  enabled: z.boolean().default(true),
  // Install directory on the computer (`services.json` `root`); lifecycle derives from it.
  root: z.string().min(1).optional(),
  lifecycle: serverLifecycleSchema.optional()
}).strict();
const deviceServerSchema = z.discriminatedUnion("transport", [mcpHttpServerSchema]);
export const mcpServerSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || "transport" in value) return value;
  return { ...value, transport: "mcp-http" };
}, deviceServerSchema);
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type StoredMcpServer = McpServerConfig;
export const serverIdInputSchema = z.object({ id: z.string().min(1) }).strict();

export type ServiceState = "running" | "stopped" | "starting" | "stopping" | "unknown";
export interface ConnectionStatus { state: ConnectionState; checkedAt?: string; latencyMs?: number; message?: string }
export interface ComputerStatus { computerId: string; ssh: ConnectionStatus }
export interface ServerStatus {
  serverId: string;
  computerId: string;
  service: ConnectionStatus & { serviceState?: ServiceState };
  transport: ConnectionStatus;
}

export type HardwareState = "initializing" | "open" | "unreachable" | "faulted" | "closing" | "closed";
export const managedHardwareSchema = z.object({
  hardwareId: z.string().min(1),
  computerId: z.string().min(1).optional(),
  serverId: z.string().min(1),
  state: z.enum(["initializing", "open", "unreachable", "faulted", "closing", "closed"]),
  health: z.string(),
  // Python datetime.isoformat() reports UTC as +00:00 and may include microseconds.
  lastError: z.object({ category: z.string().min(1), message: z.string(), at: z.string().datetime({ offset: true }).optional() }).nullable().optional()
});
export type ManagedHardware = z.infer<typeof managedHardwareSchema>;
export const reportedManagedHardwareSchema = managedHardwareSchema.omit({ computerId: true, serverId: true });
// `path` is the effective log directory (derived from `root` or the lifecycle override).
export interface RemoteServiceLog { lines: string[]; truncated: boolean; path?: string }
/** One entry of a computer's `services.json` (design doc §4.8.1); `added` if already registered. */
export interface DiscoveredService {
  serverId: string;
  hardwareId: string;
  root: string;
  port: number;
  adapter?: string;
  adapterVersion?: string;
  installedAt?: string;
  url: string;
  added: boolean;
}
export interface RegisteredService { server: McpServerConfig; status: ServerStatus }
export interface ServiceImportResult {
  imported: RegisteredService[];
  skipped: { serverId: string; reason: string }[];
}
/** An adapter in the `mcp_servers` workspace that can be packed and deployed (design doc §4.8.3). */
export interface DeployableAdapter { adapter: string; package: string; module: string; version: string; description: string }
export interface DeployServiceSpec {
  serverId: string;
  hardwareId: string;
  adapter: string;
  port: number;
  /** Windows directory; defaults to the registered root or `E:\<serverid>_server`. */
  root?: string;
  label?: string;
  settings?: Record<string, unknown>;
  dryRun?: boolean;
  autostart?: boolean;
}
export interface DeployStep { step: string; ok: boolean; skipped?: string; message?: string }
export interface DeployResult extends RegisteredService {
  root: string;
  port: number;
  createdConfig: boolean;
  upgraded: boolean;
  steps: DeployStep[];
  build: { adapter?: string; adapterModule?: string; sdkVersion?: string; sourceRevision?: string | null; builtAt?: string };
}
export interface UninstallResult { serverId: string; root: string; archive: string; steps: DeployStep[] }
export interface ToolCatalogItem {
  externalName: string;
  remoteName: string;
  serverId: string;
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
  serverId: z.string().min(1).optional(),
  computerId: z.string().min(1).optional(),
  ports: z.array(hardwarePortSchema).default([]),
  /** Managed hardware only, derived by the backend from the adapter record. */
  adapterStatus: adapterStatusSchema.optional()
}).superRefine((value, context) => {
  if (value.kind === "managed" && !value.serverId) context.addIssue({ code: z.ZodIssueCode.custom, message: "Managed hardware requires serverId" });
  if (value.kind === "passive" && (value.serverId || value.computerId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Passive hardware cannot reference remote infrastructure" });
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
  diagnostics?: { transport?: string; process?: string; ssh?: string };
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
  serverId: z.string().min(1),
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
    serverId: string;
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
