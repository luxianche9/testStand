import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  testNodeRunSchema,
  testRunEventSchema,
  testRunExecutionSnapshotSchema,
  testRunLogArchiveSchema,
  testRunSchema,
  type TestNodeRun,
  type TestRun,
  type TestRunEvent,
  type TestRunExecutionSnapshot,
  type TestRunLogArchive
} from "@testforge/contracts/orchestration";
import { atomicJson, atomicText, readJson, syncDirectory } from "./file-storage.js";

export interface LoadedRunLogs { archives: TestRunLogArchive[]; snapshots: TestRunExecutionSnapshot[]; warnings: string[] }

export interface RunLogStoreOptions {
  compactAfterBytes?: number;
  onWrite?: (write: { kind: "append" | "snapshot"; bytes: number }) => void;
}

type RunLogRecord =
  | { formatVersion: 1; type: "run.upsert"; run: TestRun }
  | { formatVersion: 1; type: "nodeRun.upsert"; nodeRun: TestNodeRun }
  | { formatVersion: 1; type: "events.append"; runId: string; events: TestRunEvent[] }
  | { formatVersion: 1; type: "execution.snapshot"; snapshot: TestRunExecutionSnapshot };

type SnapshotFile = { formatVersion: 1; archive: TestRunLogArchive; executionSnapshot?: TestRunExecutionSnapshot };

export class ProjectRunLogStore {
  private readonly operations = new Map<string, Promise<void>>();
  private readonly compactAfterBytes: number;

  constructor(private readonly options: RunLogStoreOptions = {}) {
    this.compactAfterBytes = positiveInteger(options.compactAfterBytes, 512 * 1024);
  }

  async load(rootPath: string): Promise<LoadedRunLogs> {
    await Promise.allSettled(this.operations.values());
    const directory = runDirectory(rootPath);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { archives: [], snapshots: [], warnings: [] };
      throw error;
    }

    const archives: TestRunLogArchive[] = [];
    const warnings: string[] = [];
    const snapshots: TestRunExecutionSnapshot[] = [];
    const loadedRunIds = new Set<string>();
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const loaded = await this.loadRunDirectory(join(directory, entry.name), entry.name);
      warnings.push(...loaded.warnings);
      if (loaded.archive) {
        archives.push(loaded.archive);
        loadedRunIds.add(loaded.archive.run.runId);
      }
      if (loaded.executionSnapshot) snapshots.push(loaded.executionSnapshot);
    }

    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        const raw = await readJson(join(directory, entry.name));
        const archive = testRunLogArchiveSchema.parse(raw);
        if (loadedRunIds.has(archive.run.runId)) {
          warnings.push(`${entry.name}: ignored legacy archive because a JSONL Run exists`);
          continue;
        }
        archives.push(archive);
        loadedRunIds.add(archive.run.runId);
        try { await this.migrateLegacy(rootPath, entry.name, archive); }
        catch (error) { warnings.push(`${entry.name}: failed to migrate legacy archive: ${errorMessage(error)}`); }
      } catch (error) {
        warnings.push(`${entry.name}: ${errorMessage(error)}`);
      }
    }
    return { archives, snapshots, warnings };
  }

  async upsertRun(rootPath: string, run: TestRun): Promise<void> {
    const parsed = testRunSchema.parse(run);
    await this.enqueue(rootPath, parsed.runId, async () => {
      await this.appendRecord(rootPath, parsed.runId, { formatVersion: 1, type: "run.upsert", run: parsed });
    });
  }

  async upsertNodeRun(rootPath: string, nodeRun: TestNodeRun): Promise<void> {
    const parsed = testNodeRunSchema.parse(nodeRun);
    await this.enqueue(rootPath, parsed.runId, async () => {
      await this.appendRecord(rootPath, parsed.runId, { formatVersion: 1, type: "nodeRun.upsert", nodeRun: parsed });
    });
  }

  async appendEvents(rootPath: string, runId: string, events: TestRunEvent[]): Promise<void> {
    if (events.length === 0) return;
    const parsed = events.map((event) => testRunEventSchema.parse(event));
    if (parsed.some((event) => event.runId !== runId)) throw new Error(`Event Run id does not match ${runId}`);
    await this.enqueue(rootPath, runId, async () => {
      await this.appendRecord(rootPath, runId, { formatVersion: 1, type: "events.append", runId, events: parsed });
    });
  }

  async upsertExecutionSnapshot(rootPath: string, snapshot: TestRunExecutionSnapshot): Promise<void> {
    const parsed = testRunExecutionSnapshotSchema.parse(snapshot);
    await this.enqueue(rootPath, parsed.runId, async () => {
      await this.appendRecord(rootPath, parsed.runId, { formatVersion: 1, type: "execution.snapshot", snapshot: parsed });
    });
  }

  async remove(rootPath: string, runId: string): Promise<void> {
    await this.enqueue(rootPath, runId, async () => {
      await rm(runPath(rootPath, runId), { recursive: true, force: true });
      await rm(legacyRunPath(rootPath, runId), { force: true });
      await syncDirectory(runDirectory(rootPath));
    });
  }

  async clear(rootPath: string, runIds: string[]): Promise<void> {
    for (const runId of runIds) await this.remove(rootPath, runId);
  }

  private async appendRecord(rootPath: string, runId: string, record: RunLogRecord): Promise<void> {
    const directory = runPath(rootPath, runId);
    await mkdir(directory, { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    const handle = await open(logPath(directory), "a");
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    this.options.onWrite?.({ kind: "append", bytes: Buffer.byteLength(line, "utf8") });
    if ((await stat(logPath(directory))).size >= this.compactAfterBytes) await this.compact(directory);
  }

  private async compact(directory: string): Promise<void> {
    const loaded = await this.loadRunDirectory(directory, directory);
    if (!loaded.archive || loaded.warnings.length > 0) return;
    const snapshot: SnapshotFile = {
      formatVersion: 1,
      archive: loaded.archive,
      ...(loaded.executionSnapshot ? { executionSnapshot: loaded.executionSnapshot } : {})
    };
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    await atomicText(snapshotPath(directory), text);
    this.options.onWrite?.({ kind: "snapshot", bytes: Buffer.byteLength(text, "utf8") });
    await atomicText(logPath(directory), "");
  }

  private async loadRunDirectory(directory: string, label: string): Promise<{ archive?: TestRunLogArchive; executionSnapshot?: TestRunExecutionSnapshot; warnings: string[] }> {
    const warnings: string[] = [];
    let run: TestRun | undefined;
    const nodeRuns = new Map<string, TestNodeRun>();
    const nodeOrder: string[] = [];
    const events = new Map<number, TestRunEvent>();
    let executionSnapshot: TestRunExecutionSnapshot | undefined;

    try {
      const raw = await readJson(snapshotPath(directory));
      if (raw !== undefined) {
        const snapshot = parseSnapshot(raw);
        run = snapshot.archive.run;
        executionSnapshot = snapshot.executionSnapshot;
        for (const nodeRun of snapshot.archive.nodeRuns) {
          nodeRuns.set(nodeRun.nodeRunId, nodeRun);
          nodeOrder.push(nodeRun.nodeRunId);
        }
        for (const event of snapshot.archive.events) events.set(event.eventId, event);
      }
    } catch (error) {
      warnings.push(`${label}/snapshot.json: ${errorMessage(error)}`);
    }

    let log = "";
    try { log = await readFile(logPath(directory), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${label}/run.jsonl: ${errorMessage(error)}`);
    }
    const lines = log.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      try {
        const record = parseRecord(JSON.parse(line) as unknown);
        if (record.type === "run.upsert") run = record.run;
        else if (record.type === "nodeRun.upsert") {
          if (!nodeRuns.has(record.nodeRun.nodeRunId)) nodeOrder.push(record.nodeRun.nodeRunId);
          nodeRuns.set(record.nodeRun.nodeRunId, record.nodeRun);
        } else if (record.type === "events.append") {
          for (const event of record.events) events.set(event.eventId, event);
        } else executionSnapshot = record.snapshot;
      } catch (error) {
        warnings.push(`${label}/run.jsonl:${index + 1}: ${errorMessage(error)}`);
      }
    }

    if (!run) {
      if (log.trim() || warnings.length > 0) warnings.push(`${label}: Run log does not contain a Run record`);
      return { warnings };
    }
    try {
      const archive = testRunLogArchiveSchema.parse({
        formatVersion: 1,
        run,
        nodeRuns: nodeOrder.map((nodeRunId) => nodeRuns.get(nodeRunId)!).filter(Boolean),
        events: [...events.values()].sort((left, right) => left.eventId - right.eventId)
      });
      return { archive, ...(executionSnapshot ? { executionSnapshot } : {}), warnings };
    } catch (error) {
      warnings.push(`${label}: ${errorMessage(error)}`);
      return { warnings };
    }
  }

  private async migrateLegacy(rootPath: string, legacyName: string, archive: TestRunLogArchive): Promise<void> {
    const directory = runPath(rootPath, archive.run.runId);
    await mkdir(directory, { recursive: true });
    await atomicJson(snapshotPath(directory), { formatVersion: 1, archive } satisfies SnapshotFile);
    await atomicText(logPath(directory), "");
    await rm(join(runDirectory(rootPath), legacyName), { force: true });
    await syncDirectory(runDirectory(rootPath));
  }

  private async enqueue(rootPath: string, runId: string, operation: () => Promise<void>): Promise<void> {
    const key = `${rootPath}\0${runId}`;
    const previous = this.operations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.operations.set(key, current);
    try { await current; }
    finally { if (this.operations.get(key) === current) this.operations.delete(key); }
  }
}

function parseSnapshot(raw: unknown): SnapshotFile {
  if (!raw || typeof raw !== "object" || (raw as { formatVersion?: unknown }).formatVersion !== 1) throw new Error("Unsupported snapshot formatVersion");
  const value = raw as { archive?: unknown; executionSnapshot?: unknown };
  return {
    formatVersion: 1,
    archive: testRunLogArchiveSchema.parse(value.archive),
    ...(value.executionSnapshot === undefined ? {} : { executionSnapshot: testRunExecutionSnapshotSchema.parse(value.executionSnapshot) })
  };
}

function parseRecord(raw: unknown): RunLogRecord {
  if (!raw || typeof raw !== "object") throw new Error("Run log record must be an object");
  const value = raw as { formatVersion?: unknown; type?: unknown; run?: unknown; nodeRun?: unknown; runId?: unknown; events?: unknown; snapshot?: unknown };
  if (value.formatVersion !== 1) throw new Error(`Unsupported Run log record formatVersion: ${String(value.formatVersion)}`);
  if (value.type === "run.upsert") return { formatVersion: 1, type: value.type, run: testRunSchema.parse(value.run) };
  if (value.type === "nodeRun.upsert") return { formatVersion: 1, type: value.type, nodeRun: testNodeRunSchema.parse(value.nodeRun) };
  if (value.type === "events.append") {
    if (typeof value.runId !== "string" || !Array.isArray(value.events)) throw new Error("Invalid events.append record");
    const events = value.events.map((event) => testRunEventSchema.parse(event));
    if (events.some((event) => event.runId !== value.runId)) throw new Error("Event Run id does not match record Run id");
    return { formatVersion: 1, type: value.type, runId: value.runId, events };
  }
  if (value.type === "execution.snapshot") return { formatVersion: 1, type: value.type, snapshot: testRunExecutionSnapshotSchema.parse(value.snapshot) };
  throw new Error(`Unknown Run log record type: ${String(value.type)}`);
}

function runDirectory(rootPath: string): string { return join(rootPath, ".testforge", "logs", "runs"); }
function runPath(rootPath: string, runId: string): string { return join(runDirectory(rootPath), safeSegment(runId)); }
function legacyRunPath(rootPath: string, runId: string): string { return join(runDirectory(rootPath), `${safeSegment(runId)}.json`); }
function logPath(directory: string): string { return join(directory, "run.jsonl"); }
function snapshotPath(directory: string): string { return join(directory, "snapshot.json"); }
function safeSegment(value: string): string { return encodeURIComponent(value).replace(/\*/g, "%2A"); }
function positiveInteger(value: number | undefined, fallback: number): number { return Number.isInteger(value) && value! > 0 ? value! : fallback; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
