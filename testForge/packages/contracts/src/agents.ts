export interface McpGatewayStatus {
  running: boolean;
  endpoint: string;
  tokenConfigured: boolean;
  toolCount: number;
  lastError?: string;
  lastClient?: { name: string; version?: string; connectedAt: string };
}

import { z } from "zod";

export const agentKindSchema = z.literal("codex");
export type AgentKind = z.infer<typeof agentKindSchema>;
export const agentKindInputSchema = z.object({ id: agentKindSchema }).strict();
export type AgentIntegrationState = "unavailable" | "not_installed" | "misconfigured" | "configured" | "error";
export interface AgentIntegrationStatus {
  agent: AgentKind;
  state: AgentIntegrationState;
  gateway: { running: boolean; endpoint: string; toolCount: number };
  cli: { available: boolean; path?: string; version?: string };
  environment: { name: string; state: "missing" | "mismatch" | "configured" };
  configuration: { state: "missing" | "mismatch" | "configured"; endpoint?: string; bearerTokenEnvVar?: string };
  lastClient?: McpGatewayStatus["lastClient"];
  message?: string;
}
export interface AgentIntegrationPreview {
  agent: AgentKind;
  endpoint: string;
  environmentVariable: string;
  replacesExisting: boolean;
  createsBackup: boolean;
  requiresAgentRestart: boolean;
  actions: string[];
}
export interface AgentToolInfo {
  name: string;
  kind: "builtin" | "remote";
  description?: string;
  inputSchema: Record<string, unknown>;
  serverId?: string;
  remoteName?: string;
}

export const CAPABILITIES = [
  "system.read",
  "system.manage",
  "agents.manage",
  "devices.read",
  "devices.manageComputers",
  "devices.manageServers",
  "devices.controlServers",
  "devices.forceStopServers",
  "devices.ssh",
  "hardware.read",
  "hardware.manage",
  "hardware.executeTools",
  "projects.read",
  "projects.manage",
  "wiring.read",
  "wiring.request",
  "wiring.confirm",
  "orchestration.read",
  "orchestration.manage",
  "orchestration.run",
  "orchestration.logs.manage",
  "orchestration.respondOperator"
] as const;

export type Capability = typeof CAPABILITIES[number];
export type RequestActor = "human" | "agent" | "system";
export interface RequestContext {
  actor: RequestActor;
  source: "desktop" | "mcp" | "internal";
  requestId?: string;
  subjectId?: string;
}

export type OpenCodeRuntimeState = "stopped" | "starting" | "running" | "stopping" | "error";
export interface OpenCodeRuntimeStatus {
  state: OpenCodeRuntimeState;
  workspaceState: "ready" | "requires_project";
  version: string;
  workspace?: string;
  apiUrl?: string;
  message?: string;
}
