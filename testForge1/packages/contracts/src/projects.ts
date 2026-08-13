import { z } from "zod";
import { testTaskSchema } from "./orchestration.js";
import { projectWiringSchema, type ProjectCanvasNode, type ProjectWiringConnection } from "./wiring.js";

export const projectFileSchema = z.object({
  formatVersion: z.literal(3),
  projectId: z.string().min(1),
  name: z.string().min(1),
  wiring: projectWiringSchema,
  task: testTaskSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
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
  preview: {
    nodes: ProjectCanvasNode[];
    connections: Array<Pick<ProjectWiringConnection, "connectionId" | "portA" | "portB">>;
  };
}
