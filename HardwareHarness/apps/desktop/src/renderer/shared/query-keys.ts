export const queryKeys = {
  dashboard: ["dashboard"] as const,
  deviceCatalog: ["device-catalog"] as const,
  projectDocument: ["project-document"] as const,
  recentProjects: ["recent-projects"] as const,
  wiringTasks: ["wiring-tasks"] as const,

  runLogs: ["run-logs"] as const,
  runLogList: (projectId: string | undefined, query: unknown) => ["run-logs", projectId, query] as const,
  openCodeStatus: ["opencode-status"] as const,
  llmSettings: ["llm-settings"] as const,
  agentTools: ["agent-tools"] as const,
  agentIntegration: (agent: string) => ["agent-integration", agent] as const,
  hardwareImage: (hardwareId: string, assetId: string) => ["hardware-image", hardwareId, assetId] as const
};
