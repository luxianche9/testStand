import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { testRunLogArchiveSchema, type TestRunLogArchive } from "@testforge/contracts/orchestration";
import { atomicJson, readJson } from "./file-storage.js";

export interface LoadedRunLogs { archives: TestRunLogArchive[]; warnings: string[] }

export class ProjectRunLogStore {
  async load(rootPath: string): Promise<LoadedRunLogs> {
    const directory = runDirectory(rootPath);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { archives: [], warnings: [] };
      throw error;
    }
    const archives: TestRunLogArchive[] = [];
    const warnings: string[] = [];
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        const raw = await readJson(join(directory, entry.name));
        archives.push(testRunLogArchiveSchema.parse(raw));
      } catch (error) {
        warnings.push(`${entry.name}: ${errorMessage(error)}`);
      }
    }
    return { archives, warnings };
  }

  async save(rootPath: string, archive: TestRunLogArchive): Promise<void> {
    const parsed = testRunLogArchiveSchema.parse(archive);
    await atomicJson(runPath(rootPath, parsed.run.runId), parsed);
  }

  async remove(rootPath: string, runId: string): Promise<void> {
    await rm(runPath(rootPath, runId), { force: true });
  }

  async clear(rootPath: string, runIds: string[]): Promise<void> {
    for (const runId of runIds) await this.remove(rootPath, runId);
  }
}

function runDirectory(rootPath: string): string {
  return join(rootPath, ".testforge", "logs", "runs");
}

function runPath(rootPath: string, runId: string): string {
  return join(runDirectory(rootPath), `${encodeURIComponent(runId)}.json`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
