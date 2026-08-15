import { join } from "node:path";
import { app } from "electron";
import log from "electron-log/main";

type SecretProvider = () => readonly (string | undefined)[];

const secretProviders = new Set<SecretProvider>();
const sensitiveKey = /(?:api[-_]?key|authorization|bearer|credential|password|secret|token)/i;
let initialized = false;

export function initializeLogger(): void {
  if (initialized) return;
  initialized = true;
  log.initialize();
  log.transports.file.level = "info";
  log.transports.file.maxSize = 10 * 1024 * 1024;
  log.transports.file.resolvePathFn = () => join(app.getPath("userData"), "logs", "main.log");
  log.transports.console.level = process.env.NODE_ENV === "production" ? "warn" : "debug";
}

export function registerLogSecrets(provider: SecretProvider): () => void {
  secretProviders.add(provider);
  return () => secretProviders.delete(provider);
}

export function redactSecrets(value: string, secrets: readonly (string | undefined)[] = currentSecrets()): string {
  return secrets
    .filter((secret): secret is string => Boolean(secret))
    .reduce((message, secret) => message.replaceAll(secret, "<redacted>"), value)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>")
    .replace(/\b(api[-_]?key|password|secret|token)\s*[:=]\s*([^\s,;]+)/gi, "$1=<redacted>");
}

function currentSecrets(): string[] {
  return [...secretProviders].flatMap((provider) => {
    try { return provider().filter((value): value is string => Boolean(value)); }
    catch { return []; }
  });
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecrets(value.message),
      ...(value.stack ? { stack: redactSecrets(value.stack) } : {})
    };
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    sensitiveKey.test(key) ? "<redacted>" : sanitize(entry, seen)
  ]));
}

function write(level: "debug" | "info" | "warn" | "error", values: unknown[]): void {
  initializeLogger();
  log[level](...values.map((value) => sanitize(value)));
}

export const logger = {
  debug: (...values: unknown[]) => write("debug", values),
  info: (...values: unknown[]) => write("info", values),
  warn: (...values: unknown[]) => write("warn", values),
  error: (...values: unknown[]) => write("error", values)
};
