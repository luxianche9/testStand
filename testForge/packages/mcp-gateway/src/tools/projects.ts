import type { TestForgeApplication } from "@testforge/application";
import type { RequestContext } from "@testforge/contracts/agents";
import { appError } from "@testforge/contracts/errors";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { defineTool, type GatewayToolDefinition } from "./definition.js";

const folder = z.object({ rootPath: z.string().min(1).refine(isAbsolute, "rootPath must be absolute") }).strict();

function assertCanSwitch(application: TestForgeApplication, context: RequestContext): void {
  if (application.system.dashboard(context).execution.state !== "idle") {
    throw appError("conflict", "Finish the active execution before switching projects");
  }
  if (application.projects.document(context)?.dirty) {
    throw appError("conflict", "Save the current project before switching projects");
  }
}

export const PROJECT_TOOLS: GatewayToolDefinition[] = [
  defineTool({
    name: "get_project", description: "Read the current project, root path, wiring, task and unsaved state.",
    capability: "projects.read", schema: z.object({}).strict(), annotations: { readOnlyHint: true },
    handler: (application, context) => application.projects.document(context)
  }),
  defineTool({
    name: "initialize_project", description: "Initialize a TestForge project in an existing absolute directory and open it. Refuses existing projects, unsaved changes and active execution.",
    capability: "projects.manage", schema: folder,
    handler: async (application, context, input) => {
      assertCanSwitch(application, context);
      return await application.projects.initializeFolder(context, input.rootPath);
    }
  }),
  defineTool({
    name: "open_project", description: "Open an existing TestForge project by absolute directory. Refuses unsaved changes and active execution.",
    capability: "projects.manage", schema: folder,
    handler: async (application, context, input) => {
      assertCanSwitch(application, context);
      return await application.projects.openFolder(context, input.rootPath);
    }
  }),
  defineTool({
    name: "save_project", description: "Save the current project's task and canvas through the normal project service.",
    capability: "projects.manage", schema: z.object({}).strict(),
    handler: (application, context) => application.projects.saveProject(context)
  })
];
