import { z } from "zod";

export const themeChoiceSchema = z.enum(["system", "light", "dark"]);
export type ThemeChoice = z.infer<typeof themeChoiceSchema>;
export const welcomeLayoutSchema = z.enum(["grid", "list"]);
export type WelcomeLayout = z.infer<typeof welcomeLayoutSchema>;
export const projectViewSchema = z.enum(["wiring", "orchestration", "manual", "logs"]).catch("wiring");
export type ProjectView = z.infer<typeof projectViewSchema>;

export const userSettingsSchema = z.object({
  formatVersion: z.literal(1).default(1),
  theme: themeChoiceSchema.default("system"),
  recentProjects: z.array(z.object({
    rootPath: z.string().min(1),
    name: z.string().min(1),
    openedAt: z.string().datetime()
  })).default([]),
  welcomeLayout: welcomeLayoutSchema.default("grid"),
  projectView: projectViewSchema.default("wiring"),
  llm: z.object({
    baseUrl: z.string().url().default("https://api.openai.com/v1"),
    model: z.string().trim().min(1).default("gpt-4.1")
  }).default({ baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" })
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export const llmSettingsInputSchema = z.object({
  baseUrl: z.string().trim().url(),
  model: z.string().trim().min(1),
  apiKey: z.string().optional(),
  clearApiKey: z.boolean().optional()
});
export type LlmSettingsInput = z.infer<typeof llmSettingsInputSchema>;
export interface LlmSettings { baseUrl: string; model: string; apiKeyConfigured: boolean }

export const encryptedSecretFileSchema = z.object({
  formatVersion: z.literal(1).default(1),
  entries: z.record(z.string())
});
export type EncryptedSecretFile = z.infer<typeof encryptedSecretFileSchema>;
