/**
 * Electron IPC already uses the structured clone algorithm. Keeping the tRPC
 * transformer transparent preserves Uint8Array and other cloneable values
 * without expanding binary payloads into JSON-shaped number arrays.
 */
export const hardwareHarnessTransformer = {
  serialize: (value: unknown): unknown => value,
  deserialize: (value: unknown): unknown => value
};
