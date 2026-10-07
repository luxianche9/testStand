import { z } from "zod";

export const projectRootPathInputSchema = z.object({ id: z.string().min(1) }).strict();
import { signalViewSchema } from "./signals.js";
import { projectWiringSchema } from "./wiring.js";

const projectMetadataFields = {
  projectId: z.string().min(1),
  name: z.string().min(1),
  wiring: projectWiringSchema,
  signals: signalViewSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
};

export const projectFileSchema = z.object({ formatVersion: z.literal(5), ...projectMetadataFields });
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
  preview: { connections: number; nodes: number };
}
