export const queryKeys = {
  dashboard: ["dashboard"] as const,
  deviceCatalog: ["device-catalog"] as const,
  projectDocument: ["project-document"] as const,
  recentProjects: ["recent-projects"] as const,
  wiringTasks: ["wiring-tasks"] as const,
  testPlans: ["test-plans"] as const,
  testRun: ["test-run"] as const,
  testItemStatus: ["test-item-status"] as const,
  testBatch: ["test-batch"] as const,
  testStepCatalog: ["test-step-catalog"] as const,
  testRunsAll: ["test-runs"] as const,
  testRuns: (filters: object) => ["test-runs", filters] as const,
  testDeviceTools: (hardwareId: string) => ["test-device-tools", hardwareId] as const,
  testRecovery: ["test-recovery"] as const,

  openCodeStatus: ["opencode-status"] as const,
  llmSettings: ["llm-settings"] as const,
  agentTools: ["agent-tools"] as const,
  agentIntegration: (agent: string) => ["agent-integration", agent] as const,
  hardwareImage: (hardwareId: string, assetId: string) => ["hardware-image", hardwareId, assetId] as const
};
