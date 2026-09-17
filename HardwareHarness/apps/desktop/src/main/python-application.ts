import type { BackendApplication } from "@hardwareharness/contracts/application";
import type { RequestContext } from "@hardwareharness/contracts/agents";
import type { PythonBridge } from "./python-bridge.js";

type AsyncMethods<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]:
    T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never
};
type Namespace = "devices" | "projects" | "wiring" | "manual" | "testing" | "system";
export type PythonApplication = { [K in Namespace]: AsyncMethods<BackendApplication[K]> };

export const DESKTOP_HUMAN_CONTEXT: Readonly<RequestContext> = Object.freeze({ actor: "human", source: "desktop" });

export function createPythonApplication(bridge: PythonBridge): PythonApplication {
  return Object.fromEntries(["devices", "projects", "wiring", "manual", "testing", "system"].map((namespace) => [
    namespace,
    new Proxy({}, { get: (_target, method) => (...args: unknown[]) => bridge.call(`application.${namespace}.${String(method)}`, { args }) })
  ])) as PythonApplication;
}
