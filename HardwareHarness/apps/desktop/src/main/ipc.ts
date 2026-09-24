import { initTRPC } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { agentKindSchema } from "@hardwareharness/contracts/agents";
import { DESKTOP_OPERATIONS } from "@hardwareharness/contracts/application";
import type { HardwareHarnessAgentsApi, HardwareHarnessSettingsApi } from "@hardwareharness/contracts/desktop";
import { deviceBundleKindSchema, hardwareImageTargetSchema, type DeviceBundleExport, type DeviceBundleKind } from "@hardwareharness/contracts/devices";
import { toWireError } from "@hardwareharness/contracts/errors";
import { llmSettingsInputSchema, projectViewSchema, themeChoiceSchema, welcomeLayoutSchema } from "@hardwareharness/contracts/storage";
import { DESKTOP_HUMAN_CONTEXT as HUMAN_REQUEST_CONTEXT, invokeOperation, type PythonApplication } from "./python-application.js";
import { hardwareHarnessTransformer } from "../shared/trpc-transformer.js";
import type { DesktopEventListener } from "./desktop-events.js";

interface DesktopDialogsPort {
  exportText(defaultPath: string, content: string): Promise<string | null>;
  chooseHardwareImage(): Promise<string | null>;
  saveBundle(kind: DeviceBundleKind, id: string, data: Uint8Array): Promise<DeviceBundleExport | null>;
  openBundle(kind: DeviceBundleKind): Promise<Uint8Array | null>;
  chooseProjectFolder(): Promise<string | null>;
}

type DesktopEventName = "availability" | "execution" | "wiringTask" | "workspace" | "application" | "project" | "testPlan" | "testRun" | "testBatch" | "opencode" | "window-state";

interface DesktopWindowPort {
  publish(event: DesktopEventName, payload: unknown): void;
  subscribe(event: DesktopEventName, listener: DesktopEventListener): () => void;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  applyTheme(theme: "system" | "light" | "dark"): void;
}

export interface DesktopIpcDependencies {
  application: PythonApplication;
  agents: HardwareHarnessAgentsApi;
  settings: HardwareHarnessSettingsApi;
  dialogs: DesktopDialogsPort;
  windows: DesktopWindowPort;
}

const trpc = initTRPC.create({
  transformer: hardwareHarnessTransformer,
  errorFormatter({ shape, error }) {
    const wire = toWireError(error.cause ?? error);
    const category = error.code === "BAD_REQUEST" && wire.category === "error" ? "invalid_argument" : wire.category;
    return {
      ...shape,
      data: {
        ...shape.data,
        category,
        ...(wire.details === undefined ? {} : { details: wire.details })
      }
    };
  }
});

const emptyInput = z.void().optional();
const eventNameSchema = z.enum(["availability", "execution", "wiringTask", "workspace", "application", "project", "testPlan", "testRun", "testBatch", "opencode", "window-state"]);

export function createDesktopRouter(dependencies: DesktopIpcDependencies) {
  const { application, agents, settings, dialogs, windows } = dependencies;

  return trpc.router({
    /** Every Python `@operation`; argument validation belongs to the Python registry. */
    invoke: trpc.procedure.input(z.object({ operation: z.enum(DESKTOP_OPERATIONS), args: z.array(z.unknown()) }).strict())
      .mutation(async ({ input }) => {
        const result = await invokeOperation(application, input.operation, input.args.map(withoutUndefinedMembers));
        if (input.operation === "wiring.updateDocument") windows.publish("project", result);
        return result;
      }),
    system: trpc.router({
      exportText: trpc.procedure.input(z.object({ defaultPath: z.string().min(1), content: z.string() }).strict())
        .mutation(({ input }) => dialogs.exportText(input.defaultPath, input.content))
    }),
    devices: trpc.router({
      importHardwareImage: trpc.procedure.input(hardwareImageTargetSchema).mutation(async ({ input }) => {
        const path = await dialogs.chooseHardwareImage();
        return path ? await application.devices.setHardwareImageFromPath(HUMAN_REQUEST_CONTEXT, input.hardwareId, input.portId, path) : null;
      }),
      exportBundle: trpc.procedure.input(z.object({ kind: deviceBundleKindSchema, id: z.string().min(1) }).strict()).mutation(async ({ input }) => {
        const data = await application.devices.exportBundle(HUMAN_REQUEST_CONTEXT, input.id);
        return await dialogs.saveBundle(input.kind, input.id, data);
      }),
      importBundle: trpc.procedure.input(z.object({ kind: deviceBundleKindSchema }).strict()).mutation(async ({ input }) => {
        const data = await dialogs.openBundle(input.kind);
        return data ? { kind: input.kind, ...await application.devices.importBundle(HUMAN_REQUEST_CONTEXT, data) } : null;
      }),
      previewBundle: trpc.procedure.input(z.object({ kind: deviceBundleKindSchema }).strict()).mutation(async ({ input }) => {
        const data = await dialogs.openBundle(input.kind);
        return data ? { kind: input.kind, hardware: await application.devices.inspectBundle(HUMAN_REQUEST_CONTEXT, data), data } : null;
      })
    }),
    projects: trpc.router({
      chooseFolder: trpc.procedure.input(emptyInput).mutation(async () => {
        const rootPath = await dialogs.chooseProjectFolder();
        return rootPath ? await application.projects.inspectFolder(HUMAN_REQUEST_CONTEXT, rootPath) : null;
      })
    }),
    agents: trpc.router({
      rotateGatewayToken: trpc.procedure.input(emptyInput).mutation(() => agents.rotateGatewayToken()),
      status: trpc.procedure.input(z.object({ agent: agentKindSchema }).strict()).query(({ input }) => agents.status(input.agent)),
      preview: trpc.procedure.input(z.object({ agent: agentKindSchema }).strict()).query(({ input }) => agents.preview(input.agent)),
      install: trpc.procedure.input(z.object({ agent: agentKindSchema }).strict()).mutation(({ input }) => agents.install(input.agent)),
      remove: trpc.procedure.input(z.object({ agent: agentKindSchema }).strict()).mutation(({ input }) => agents.remove(input.agent)),
      test: trpc.procedure.input(z.object({ agent: agentKindSchema }).strict()).mutation(({ input }) => agents.test(input.agent)),
      listTools: trpc.procedure.input(emptyInput).query(() => agents.listTools()),
      openCodeStatus: trpc.procedure.input(emptyInput).query(() => agents.openCodeStatus()),
      startOpenCode: trpc.procedure.input(emptyInput).mutation(() => agents.startOpenCode()),
      stopOpenCode: trpc.procedure.input(emptyInput).mutation(() => agents.stopOpenCode()),
      restartOpenCode: trpc.procedure.input(emptyInput).mutation(() => agents.restartOpenCode())
    }),
    settings: trpc.router({
      getTheme: trpc.procedure.input(emptyInput).query(() => settings.getTheme()),
      setTheme: trpc.procedure.input(z.object({ theme: themeChoiceSchema }).strict()).mutation(async ({ input }) => {
        await settings.setTheme(input.theme);
        windows.applyTheme(input.theme);
      }),
      getProjectView: trpc.procedure.input(emptyInput).query(() => settings.getProjectView()),
      setProjectView: trpc.procedure.input(z.object({ view: projectViewSchema }).strict()).mutation(({ input }) => settings.setProjectView(input.view)),
      getWelcomeLayout: trpc.procedure.input(emptyInput).query(() => settings.getWelcomeLayout()),
      setWelcomeLayout: trpc.procedure.input(z.object({ layout: welcomeLayoutSchema }).strict()).mutation(({ input }) => settings.setWelcomeLayout(input.layout)),
      getLlm: trpc.procedure.input(emptyInput).query(() => settings.getLlm()),
      saveLlm: trpc.procedure.input(llmSettingsInputSchema).mutation(({ input }) => settings.saveLlm(input))
    }),
    window: trpc.router({
      minimize: trpc.procedure.input(emptyInput).mutation(() => windows.minimize()),
      toggleMaximize: trpc.procedure.input(emptyInput).mutation(() => windows.toggleMaximize()),
      close: trpc.procedure.input(emptyInput).mutation(() => windows.close())
    }),
    events: trpc.router({
      subscribe: trpc.procedure.input(z.object({ event: eventNameSchema }).strict()).subscription(({ input }) => observable<unknown>((emit) => {
        const unsubscribe = windows.subscribe(input.event, (payload) => emit.next(payload));
        return unsubscribe;
      }))
    })
  });
}

export type AppRouter = ReturnType<typeof createDesktopRouter>;

/** Drop `undefined` object members so desktop calls reach Python with JSON semantics, as MCP calls do. */
function withoutUndefinedMembers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefinedMembers);
  if (value === null || typeof value !== "object") return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, withoutUndefinedMembers(item)]));
}
