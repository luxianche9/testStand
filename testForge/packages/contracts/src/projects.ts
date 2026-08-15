import { z } from "zod";

export const projectRootPathInputSchema = z.object({ id: z.string().min(1) }).strict();
import { testTaskSchema } from "./orchestration.js";
import { projectWiringSchema, type ProjectCanvasNode, type ProjectWiringConnection } from "./wiring.js";

const projectMetadataFields = {
  projectId: z.string().min(1),
  name: z.string().min(1),
  wiring: projectWiringSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
};

export const projectFileV1Schema = z.object({
  formatVersion: z.literal(1),
  ...projectMetadataFields,
  task: testTaskSchema.optional()
});

export const projectFileV2Schema = z.object({
  formatVersion: z.literal(2),
  ...projectMetadataFields,
  task: testTaskSchema
});

export const projectFileV3Schema = z.object({
  formatVersion: z.literal(3),
  ...projectMetadataFields,
  task: testTaskSchema,
});
export type ProjectFile = z.infer<typeof projectFileV3Schema>;
export const projectFileVersionSchema = z.discriminatedUnion("formatVersion", [projectFileV1Schema, projectFileV2Schema, projectFileV3Schema]);
export type ProjectFileVersion = z.infer<typeof projectFileVersionSchema>;

export function upgradeProjectFile(source: ProjectFileVersion): ProjectFile {
  let current: z.infer<typeof projectFileV2Schema> | ProjectFile;
  if (source.formatVersion === 1) {
    current = {
      ...source,
      formatVersion: 2,
      task: source.task ?? {
        formatVersion: 2,
        taskId: `${source.projectId}-task`,
        name: source.name,
        inputs: [],
        variables: [],
        setup: [],
        steps: [],
        cleanup: []
      }
    };
  } else {
    current = source;
  }
  if (current.formatVersion === 2) return projectFileV3Schema.parse({ ...current, formatVersion: 3 });
  return projectFileV3Schema.parse(current);
}

export const projectFileSchema = projectFileVersionSchema.transform((source): ProjectFile => upgradeProjectFile(source));

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
