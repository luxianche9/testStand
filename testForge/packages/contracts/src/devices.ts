import { z } from "zod";

export const connectionStateSchema = z.enum(["unknown", "checking", "online", "offline", "error"]);
export type ConnectionState = z.infer<typeof connectionStateSchema>;

export const remoteComputerSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  address: z.string().min(1),
  ssh: z.object({
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().min(1),
    hostKeyFingerprint: z.string().optional(),
    shell: z.enum(["powershell", "posix"]).default("powershell")
  })
});
export type RemoteComputer = z.infer<typeof remoteComputerSchema>;
export type StoredRemoteComputer = RemoteComputer;
export const computerIdInputSchema = z.object({ id: z.string().min(1) }).strict();

const serverLifecycleSchema = z.object({
  statusCommand: z.string().min(1),
  startCommand: z.string().min(1),
  stopCommand: z.string().min(1),
  logPath: z.string().min(1)
}).strict();

export const mcpHttpServerSchema = z.object({
  transport: z.literal("mcp-http"),
  serverId: z.string().min(1),
  computerId: z.string().min(1),
  label: z.string().min(1),
  hardwareId: z.string().min(1),
  url: z.string().url(),
  enabled: z.boolean().default(true),
  lifecycle: serverLifecycleSchema
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
  computerId: z.string().min(1),
  serverId: z.string().min(1),
  state: z.enum(["initializing", "open", "unreachable", "faulted", "closing", "closed"]),
  health: z.string(),
  lastError: z.object({ category: z.string().min(1), message: z.string(), at: z.string().datetime().optional() }).nullable().optional()
});
export type ManagedHardware = z.infer<typeof managedHardwareSchema>;
export const reportedManagedHardwareSchema = managedHardwareSchema.omit({ computerId: true, serverId: true });
export interface RemoteServiceLog { lines: string[]; truncated: boolean }
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
  pins: z.array(hardwarePinSchema).default([]),
  imageAssetId: z.string().min(1).optional()
});
export type HardwarePort = z.infer<typeof hardwarePortSchema>;

const hardwareFields = {
  hardwareId: z.string().min(1),
  label: z.string().min(1),
  ports: z.array(hardwarePortSchema).default([]),
  appearanceAssetId: z.string().min(1).optional()
};
export const storedHardwareDefinitionSchema = z.object({ formatVersion: z.literal(2).default(2), ...hardwareFields });
export type StoredHardwareDefinition = z.infer<typeof storedHardwareDefinitionSchema>;

export const hardwareSchema = z.object({
  formatVersion: z.literal(2).default(2),
  hardwareId: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["managed", "passive"]),
  serverId: z.string().min(1).optional(),
  computerId: z.string().min(1).optional(),
  ports: z.array(hardwarePortSchema).default([]),
  appearanceAssetId: z.string().min(1).optional()
}).superRefine((value, context) => {
  if (value.kind === "managed" && (!value.serverId || !value.computerId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Managed hardware requires serverId and computerId" });
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
export const assetIdInputSchema = z.object({ id: z.string().min(1) }).strict();

export const hardwareImageTargetSchema = z.object({ hardwareId: z.string().min(1), portId: z.string().min(1).optional() }).strict();
export type HardwareImageTarget = z.infer<typeof hardwareImageTargetSchema>;
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
