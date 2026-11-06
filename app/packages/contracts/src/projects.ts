import { z } from "zod";

export const projectRootPathInputSchema = z.object({ id: z.string().min(1) }).strict();
import { monitorSchema } from "./monitor.js";
import { projectWiringSchema } from "./wiring.js";

/**
 * An ICD on a raw bytes/frames stream of a device (design §6.4). Its numeric fields become streams of the
 * source hardware, `<alias>.<message>.<field>`, for the monitor, the Agent and every test plan.
 */
export const protocolBindingSchema = z.object({
  icd: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  alias: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(64),
  source: z.object({ hardwareId: z.string().min(1), streamId: z.string().min(1) }).strict()
}).strict();
export type ProtocolBinding = z.infer<typeof protocolBindingSchema>;

/** A binding as `protocols.list` reports it: `ok` with the field streams it derives, or why it derives none. */
export interface ProtocolBindingState extends ProtocolBinding {
  ok: boolean;
  error?: string;
  icdHash?: string;
  transport?: "bytes" | "frames";
  streams?: { streamId: string; message: string; field: string; unit?: string; label?: string }[];
}

const projectMetadataFields = {
  projectId: z.string().min(1),
  name: z.string().min(1),
  wiring: projectWiringSchema,
  monitor: monitorSchema,
  protocols: z.array(protocolBindingSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
};

export const projectFileSchema = z.object({ formatVersion: z.literal(8), ...projectMetadataFields });
export type ProjectFile = z.infer<typeof projectFileSchema>;

export interface ProjectDocument {
  rootPath: string;
  path: string;
  dirty: boolean;
  file: ProjectFile;
}

export type ProjectFolderSelection = {
  rootPath: string;
  state: "ready" | "uninitialized" | "invalid";
  name: string;
  message?: string;
};

export type RecentProjectStatus = "available" | "missing" | "invalid";

export interface RecentProjectSummary {
  rootPath: string;
  name: string;
  openedAt: string;
  updatedAt?: string;
  status: RecentProjectStatus;
  message?: string;
  /** How much the project holds: physical connections and signal view nodes. */
  preview: { connections: number; channels: number };
}
