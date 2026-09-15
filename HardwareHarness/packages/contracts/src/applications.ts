import { z } from "zod";

export const runIdInputSchema = z.object({ id: z.string().min(1) }).strict();
export const workspacePathSchema = z.string().min(1);
export const fileWriteSchema = z.object({ path: workspacePathSchema, content: z.string(), expectedHash: z.string() }).strict();
export const fileCreateSchema = z.object({ path: workspacePathSchema, kind: z.enum(["file", "directory"]), content: z.string().optional() }).strict();
export const fileRenameSchema = z.object({ path: workspacePathSchema, target: workspacePathSchema }).strict();
export const runStartSchema = z.object({
  name: z.string().min(1).optional(), entrypoint: z.string().min(1), inputs: z.record(z.unknown()).default({}),
  hardwareIds: z.array(z.string().min(1)).default([]), inputSchema: z.record(z.unknown()).optional()
}).strict();
export type RunStartInput = z.input<typeof runStartSchema>;
export type FileWriteInput = z.infer<typeof fileWriteSchema>;
export type FileCreateInput = z.infer<typeof fileCreateSchema>;
export type FileRenameInput = z.infer<typeof fileRenameSchema>;
export type RunStatus = "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface WorkspaceEntry { path: string; name: string; kind: "file" | "directory" }
export interface WorkspaceFile { path: string; content: string; hash: string }
export interface WorkspaceSearchResult { path: string; line: number; column: number; text: string }
export interface WorkspaceDiagnostic { path: string; line: number; column: number; severity: string; message: string; code: string }
export interface WorkspaceEnvironment { status: "missing" | "preparing" | "ready"; pythonPath: string | null; error: string | null }
export interface RunRecord {
  runId: string; name: string; entrypoint: string; inputs: Record<string, unknown>; hardwareIds: string[];
  status: RunStatus; startedAt: string; completedAt?: string;
  durationMs?: number; result?: unknown; error?: { category: string; message: string; details?: unknown };
  eventCount: number; sourcePath: string;
}
export interface RunEvent {
  runId: string; sequence: number; type: string; timestamp: string; spanId?: string; parentSpanId?: string;
  name?: string; data: Record<string, unknown>;
}
export interface RunDetail { run: RunRecord; events: RunEvent[]; hasMore: boolean }
export const runListQuerySchema = z.object({
  statuses: z.array(z.enum(["running", "cancelling", "succeeded", "failed", "cancelled", "interrupted"])).optional(),
  search: z.string().optional(), limit: z.number().int().min(1).max(10000).optional(), offset: z.number().int().min(0).optional()
}).strict();
export type RunListQuery = z.infer<typeof runListQuerySchema>;

export interface HardwareHarnessApplicationsApi {
  listFiles(): Promise<WorkspaceEntry[]>;
  readFile(path: string): Promise<WorkspaceFile>;
  writeFile(input: FileWriteInput): Promise<WorkspaceFile>;
  createFile(input: FileCreateInput): Promise<void>;
  renameFile(input: FileRenameInput): Promise<void>;
  deleteFile(path: string): Promise<void>;
  search(query: string): Promise<WorkspaceSearchResult[]>;
  diagnostics(path: string, content?: string): Promise<WorkspaceDiagnostic[]>;
  initializeWorkspace(options?: { online?: boolean }): Promise<WorkspaceEnvironment>;
  startRun(input: RunStartInput): Promise<RunRecord>;
  cancelRun(runId: string): Promise<RunRecord>;
  getRun(runId: string): Promise<RunDetail>;
  listRuns(input?: RunListQuery): Promise<RunRecord[]>;
  runEvents(runId: string, after?: number, limit?: number): Promise<RunEvent[]>;
  exportRun(runId: string): Promise<RunDetail>;
  deleteRun(runId: string): Promise<{ runId: string }>;
  clearCompletedRuns(): Promise<{ deleted: number }>;
  readRunSource(runId: string, path: string): Promise<WorkspaceFile>;
  readRunAttachment(runId: string, path: string): Promise<{ name: string; mediaType: string; content: Uint8Array }>;
}
