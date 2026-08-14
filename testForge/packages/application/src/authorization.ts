import { CAPABILITIES, type Capability, type RequestContext } from "@testforge/contracts/agents";

export interface Authorizer {
  isAllowed(context: RequestContext, capability: Capability): boolean;
  authorize(context: RequestContext, capability: Capability): void;
  allowedCapabilities(context: RequestContext): Capability[];
}

const AGENT_CAPABILITIES = new Set<Capability>([
  "system.read",
  "devices.read",
  "devices.controlServers",
  "hardware.read",
  "hardware.manage",
  "hardware.executeTools",
  "projects.read",
  "projects.manage",
  "wiring.read",
  "wiring.request",
  "orchestration.read",
  "orchestration.manage",
  "orchestration.run"
]);

export class DefaultAuthorizer implements Authorizer {
  isAllowed(context: RequestContext, capability: Capability): boolean {
    return context.actor === "human" || context.actor === "system" || AGENT_CAPABILITIES.has(capability);
  }

  authorize(context: RequestContext, capability: Capability): void {
    if (this.isAllowed(context, capability)) return;
    throw Object.assign(
      new Error(`${context.actor} is not authorized for capability ${capability}`),
      { category: "permission_denied", capability }
    );
  }

  allowedCapabilities(context: RequestContext): Capability[] {
    return CAPABILITIES.filter((capability) => this.isAllowed(context, capability));
  }
}

export const HUMAN_REQUEST_CONTEXT: Readonly<RequestContext> = Object.freeze({ actor: "human", source: "desktop" });
export const AGENT_REQUEST_CONTEXT: Readonly<RequestContext> = Object.freeze({ actor: "agent", source: "mcp" });
export const SYSTEM_REQUEST_CONTEXT: Readonly<RequestContext> = Object.freeze({ actor: "system", source: "internal" });
