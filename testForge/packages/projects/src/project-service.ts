import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  projectFileSchema,
  type ProjectDocument,
  type ProjectFile,
  type ProjectFolderSelection,
  type RecentProjectSummary
} from "@testforge/contracts/projects";
import { projectWiringSchema, type ProjectWiring } from "@testforge/contracts/wiring";
import { testTaskSchema, type TestTask } from "@testforge/contracts/orchestration";
import { appError } from "@testforge/contracts/errors";
import { atomicJson, readJson, type SettingsStore } from "@testforge/storage";

const EMPTY_WIRING: ProjectWiring = { nodes: [], connections: [] };
const PROJECT_DIRECTORY = ".testforge";
const PROJECT_FILENAME = "project.json";

export class ProjectService {
  private rootPath: string | undefined;
  private path: string | undefined;
  private file: ProjectFile | undefined;
  private dirty = false;

  constructor(private readonly settings: SettingsStore) {}

  async initialize(): Promise<null> {
    this.clearCurrent();
    return null;
  }

  current(): ProjectDocument | null {
    if (!this.rootPath || !this.path || !this.file) return null;
    return {
      rootPath: this.rootPath,
      path: this.path,
      dirty: this.dirty,
      file: structuredClone(this.file)
    };
  }

  document(): ProjectDocument {
    return this.requireDocument();
  }

  session(): { projectId: string; rootPath: string } | undefined {
    if (!this.file || !this.rootPath) return undefined;
    return { projectId: this.file.projectId, rootPath: this.rootPath };
  }

  /** Project id for run records and other callers that only need the open document's identity. */
  projectId(): string {
    return this.requireFile().projectId;
  }

  wiring(): ProjectWiring {
    return structuredClone(this.requireFile().wiring);
  }

  task(): TestTask {
    return structuredClone(this.requireFile().task);
  }

  async inspectFolder(rootPath: string): Promise<ProjectFolderSelection> {
    const root = await canonicalDirectory(rootPath);
    const path = projectPath(root);
    const name = basename(root) || root;
    try {
      const raw = await readJson(path);
      if (raw === undefined) return { rootPath: root, state: "uninitialized", name };
      const file = projectFileSchema.parse(raw);
      return { rootPath: root, state: "ready", name: file.name };
    } catch (error) {
      return { rootPath: root, state: "invalid", name, message: errorMessage(error) };
    }
  }

  async initializeFolder(rootPath: string): Promise<ProjectDocument> {
    const selection = await this.inspectFolder(rootPath);
    if (selection.state === "ready") throw appError("project_exists", "project_exists");
    if (selection.state === "invalid") throw appError("invalid_project", selection.message ?? "invalid_project");
    const file = emptyProjectFile(selection.name);
    const path = projectPath(selection.rootPath);
    await atomicJson(path, file);
    this.rootPath = selection.rootPath;
    this.path = path;
    this.file = file;
    this.dirty = false;
    await this.rememberCurrent();
    return this.requireDocument();
  }

  async openFolder(rootPath: string): Promise<ProjectDocument> {
    const selection = await this.inspectFolder(rootPath);
    if (selection.state === "uninitialized") throw appError("project_uninitialized", "project_uninitialized");
    if (selection.state === "invalid") throw appError("invalid_project", selection.message ?? "invalid_project");
    const path = projectPath(selection.rootPath);
    const raw = await readJson(path);
    const file = projectFileSchema.parse(raw);
    if (storedProjectVersion(raw) !== file.formatVersion) await atomicJson(path, file);
    this.rootPath = selection.rootPath;
    this.path = path;
    this.file = file;
    this.dirty = false;
    await this.rememberCurrent();
    return this.requireDocument();
  }

  async save(): Promise<ProjectDocument> {
    const path = this.requireDocument().path;
    const next = projectFileSchema.parse({
      ...this.requireFile(),
      updatedAt: new Date().toISOString()
    });
    await atomicJson(path, next);
    this.file = next;
    this.dirty = false;
    await this.rememberCurrent();
    return this.requireDocument();
  }

  async leave(): Promise<void> {
    this.clearCurrent();
  }

  async listRecent(): Promise<RecentProjectSummary[]> {
    const recent = this.settings.get().recentProjects;
    return await Promise.all(recent.map(async (item): Promise<RecentProjectSummary> => {
      const rootPath = resolve(item.rootPath);
      const fallback = {
        rootPath,
        name: item.name,
        openedAt: item.openedAt,
        preview: { nodes: [], connections: [] }
      };
      try {
        const info = await stat(rootPath);
        if (!info.isDirectory()) return { ...fallback, status: "missing", message: "project_folder_missing" };
      } catch (error) {
        return { ...fallback, status: "missing", message: errorMessage(error) };
      }
      try {
        const raw = await readJson(projectPath(rootPath));
        if (raw === undefined) return { ...fallback, status: "invalid", message: "project_manifest_missing" };
        const file = projectFileSchema.parse(raw);
        return {
          rootPath,
          name: file.name,
          openedAt: item.openedAt,
          updatedAt: file.updatedAt,
          status: "available",
          preview: {
            nodes: structuredClone(file.wiring.nodes),
            connections: file.wiring.connections.map(({ connectionId, portA, portB }) => ({ connectionId, portA, portB }))
          }
        };
      } catch (error) {
        return { ...fallback, status: "invalid", message: errorMessage(error) };
      }
    }));
  }

  async forgetRecent(rootPath: string): Promise<void> {
    const key = normalizedPath(rootPath);
    await this.settings.update({
      recentProjects: this.settings.get().recentProjects.filter((item) => normalizedPath(item.rootPath) !== key)
    });
  }

  updateWiring(wiring: ProjectWiring): ProjectDocument {
    const file = this.requireFile();
    this.file = {
      ...file,
      wiring: projectWiringSchema.parse(wiring),
      updatedAt: new Date().toISOString()
    };
    this.dirty = true;
    return this.requireDocument();
  }

  updateTask(task: TestTask): ProjectDocument {
    const file = this.requireFile();
    this.file = {
      ...file,
      task: testTaskSchema.parse(task),
      name: task.name.trim() || file.name,
      updatedAt: new Date().toISOString()
    };
    this.dirty = true;
    return this.requireDocument();
  }

  async close(): Promise<void> {
    /* explicit save owns the disk */
  }

  private requireFile(): ProjectFile {
    if (!this.file) throw appError("requires_project", "requires_project");
    return this.file;
  }

  private requireDocument(): ProjectDocument {
    const file = this.requireFile();
    if (!this.rootPath || !this.path) throw appError("requires_project", "requires_project");
    return { rootPath: this.rootPath, path: this.path, dirty: this.dirty, file: structuredClone(file) };
  }

  private clearCurrent(): void {
    this.rootPath = undefined;
    this.path = undefined;
    this.file = undefined;
    this.dirty = false;
  }

  private async rememberCurrent(): Promise<void> {
    const current = this.requireDocument();
    const key = normalizedPath(current.rootPath);
    const next = [
      { rootPath: current.rootPath, name: current.file.name, openedAt: new Date().toISOString() },
      ...this.settings.get().recentProjects.filter((item) => normalizedPath(item.rootPath) !== key)
    ];
    await this.settings.update({ recentProjects: next });
  }
}

export function emptyProjectFile(name = "Untitled project"): ProjectFile {
  const now = new Date().toISOString();
  return projectFileSchema.parse({
    formatVersion: 3,
    projectId: randomUUID(),
    name,
    wiring: EMPTY_WIRING,
    task: {
      formatVersion: 2,
      taskId: randomUUID(),
      name: "Untitled task",
      inputs: [],
      variables: [],
      setup: [],
      steps: [],
      cleanup: []
    },
    createdAt: now,
    updatedAt: now
  });
}

export function projectPath(rootPath: string): string {
  return join(resolve(rootPath), PROJECT_DIRECTORY, PROJECT_FILENAME);
}

export function projectDisplayName(document: ProjectDocument): string {
  return document.file.name || basename(document.rootPath);
}

async function canonicalDirectory(rootPath: string): Promise<string> {
  const target = resolve(rootPath);
  const info = await stat(target);
  if (!info.isDirectory()) throw appError("invalid_project_folder", "invalid_project_folder");
  try { return await realpath(target); }
  catch { return target; }
}

function normalizedPath(value: string): string {
  const target = resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? target.toLowerCase() : target;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storedProjectVersion(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const version = (raw as { formatVersion?: unknown }).formatVersion;
  return typeof version === "number" ? version : undefined;
}
