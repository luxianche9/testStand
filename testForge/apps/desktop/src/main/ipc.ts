import { initTRPC } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { agentKindSchema } from "@testforge/contracts/agents";
import type { TestForgeAgentsApi, TestForgeSettingsApi } from "@testforge/contracts/desktop";
import {
  computerIdInputSchema,
  deviceBundleApplyInputSchema,
  deviceBundleKindSchema,
  hardwareIdInputSchema,
  hardwareImageTargetSchema,
  hardwareSchema,
  mcpServerSchema,
  remoteComputerSchema,
  serverIdInputSchema,
  type DeviceBundleExport,
  type DeviceBundleKind
} from "@testforge/contracts/devices";
import { toWireError } from "@testforge/contracts/errors";
import { manualToolInvocationInputSchema } from "@testforge/contracts/execution";
import {
  occupancyHardwareIdInputSchema,
  occupancyRequestIdInputSchema,
  occupancyRequestListQuerySchema
} from "@testforge/contracts/occupancy";
import { runIdInputSchema, testRunListQuerySchema, testTaskSchema } from "@testforge/contracts/orchestration";
import { projectRootPathInputSchema, type ProjectDocument } from "@testforge/contracts/projects";
import { llmSettingsInputSchema, projectViewSchema, themeChoiceSchema, welcomeLayoutSchema } from "@testforge/contracts/storage";
import {
  projectWiringSchema,
  requestWiringTaskInputSchema,
  wiringOutcomeSchema,
  wiringTaskIdInputSchema,
  wiringTaskListQuerySchema
} from "@testforge/contracts/wiring";
import { HUMAN_REQUEST_CONTEXT, type TestForgeApplication } from "@testforge/application";
import { testForgeTransformer } from "../shared/trpc-transformer.js";
import type { DesktopEventListener } from "./desktop-events.js";

interface DesktopDialogsPort {
  exportText(defaultPath: string, content: string): Promise<string | null>;
  chooseHardwareImage(): Promise<string | null>;
  saveBundle(kind: DeviceBundleKind, id: string, data: Uint8Array): Promise<DeviceBundleExport | null>;
  openBundle(kind: DeviceBundleKind): Promise<Uint8Array | null>;
  chooseProjectFolder(): Promise<string | null>;
}

type DesktopEventName = "availability" | "execution" | "occupancy" | "occupancyRequest" | "run" | "nodeRun" | "wiringTask" | "operator" | "project" | "opencode" | "window-state";

interface DesktopWindowPort {
  publish(event: DesktopEventName, payload: unknown): void;
  subscribe(event: DesktopEventName, listener: DesktopEventListener): () => void;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  applyTheme(theme: "system" | "light" | "dark"): void;
}

export interface DesktopIpcDependencies {
  application: TestForgeApplication;
  agents: TestForgeAgentsApi;
  settings: TestForgeSettingsApi;
  dialogs: DesktopDialogsPort;
  windows: DesktopWindowPort;
  workspaceChanged(): Promise<void>;
}

const trpc = initTRPC.create({
  transformer: testForgeTransformer,
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
const eventNameSchema = z.enum(["availability", "execution", "occupancy", "occupancyRequest", "run", "nodeRun", "wiringTask", "operator", "project", "opencode", "window-state"]);

export function createDesktopRouter(dependencies: DesktopIpcDependencies) {
  const { application, agents, settings, dialogs, windows } = dependencies;

  const notifyProject = async <T extends ProjectDocument>(document: T, workspaceChanged: boolean): Promise<T> => {
    windows.publish("project", document);
    if (workspaceChanged) await dependencies.workspaceChanged();
    return document;
  };

  return trpc.router({
    system: trpc.router({
      dashboard: trpc.procedure.input(emptyInput).query(() => application.system.dashboard(HUMAN_REQUEST_CONTEXT)),
      exportText: trpc.procedure.input(z.object({ defaultPath: z.string().min(1), content: z.string() }).strict())
        .mutation(({ input }) => dialogs.exportText(input.defaultPath, input.content))
    }),
    devices: trpc.router({
      saveComputer: trpc.procedure.input(z.object({
        computer: remoteComputerSchema,
        credentials: z.object({ ssh: z.string().optional() }).strict().optional()
      }).strict()).mutation(({ input }) => application.devices.saveComputer(
        HUMAN_REQUEST_CONTEXT,
        input.computer,
        input.credentials?.ssh === undefined ? undefined : { ssh: input.credentials.ssh }
      )),
      removeComputer: trpc.procedure.input(computerIdInputSchema).mutation(async ({ input }) => {
        await application.devices.removeComputer(HUMAN_REQUEST_CONTEXT, input.id);
      }),
      refreshComputer: trpc.procedure.input(computerIdInputSchema).query(({ input }) => application.devices.getComputerStatus(HUMAN_REQUEST_CONTEXT, input.id)),
      saveServer: trpc.procedure.input(z.object({
        server: mcpServerSchema,
        credentials: z.object({ mcpToken: z.string().optional() }).strict().optional()
      }).strict()).mutation(({ input }) => application.devices.saveServer(
        HUMAN_REQUEST_CONTEXT,
        input.server,
        input.credentials?.mcpToken === undefined ? undefined : { mcpToken: input.credentials.mcpToken }
      )),
      removeServer: trpc.procedure.input(serverIdInputSchema).mutation(async ({ input }) => {
        await application.devices.removeServer(HUMAN_REQUEST_CONTEXT, input.id);
      }),
      refreshServer: trpc.procedure.input(serverIdInputSchema).query(({ input }) => application.devices.refreshServer(HUMAN_REQUEST_CONTEXT, input.id)),
      serverAction: trpc.procedure.input(z.object({ id: z.string().min(1), action: z.enum(["start", "stop", "restart", "force-stop"]) }).strict())
        .mutation(({ input }) => application.devices.serverAction(HUMAN_REQUEST_CONTEXT, input.id, input.action)),
      readServerLogs: trpc.procedure.input(z.object({ id: z.string().min(1), lines: z.number().int().min(1).optional() }).strict())
        .query(({ input }) => application.devices.readServerLogs(HUMAN_REQUEST_CONTEXT, input.id, input.lines)),
      executeSsh: trpc.procedure.input(z.object({ id: z.string().min(1), command: z.string(), timeoutMs: z.number().int().min(1).optional() }).strict())
        .mutation(({ input }) => application.devices.executeSsh(HUMAN_REQUEST_CONTEXT, input.id, input.command, input.timeoutMs)),
      refreshManagedHardware: trpc.procedure.input(emptyInput).query(() => application.devices.listManagedHardware(HUMAN_REQUEST_CONTEXT)),
      listHardware: trpc.procedure.input(emptyInput).query(() => application.devices.listHardware(HUMAN_REQUEST_CONTEXT)),
      saveHardware: trpc.procedure.input(hardwareSchema).mutation(({ input }) => application.devices.saveHardware(HUMAN_REQUEST_CONTEXT, input)),
      removeHardware: trpc.procedure.input(hardwareIdInputSchema).mutation(async ({ input }) => {
        await application.devices.removeHardware(HUMAN_REQUEST_CONTEXT, input.id);
      }),
      hardwareImageUrl: trpc.procedure.input(z.object({ hardwareId: z.string().min(1), assetId: z.string().min(1) }).strict())
        .query(({ input }) => `testforge-asset://local/${encodeURIComponent(input.hardwareId)}/${input.assetId.split("/").map(encodeURIComponent).join("/")}`),
      importHardwareImage: trpc.procedure.input(hardwareImageTargetSchema).mutation(async ({ input }) => {
        const path = await dialogs.chooseHardwareImage();
        return path ? await application.devices.setHardwareImageFromPath(HUMAN_REQUEST_CONTEXT, input.hardwareId, input.portId, path) : null;
      }),
      removeHardwareImage: trpc.procedure.input(hardwareImageTargetSchema)
        .mutation(({ input }) => application.devices.removeHardwareImage(HUMAN_REQUEST_CONTEXT, input.hardwareId, input.portId)),
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
      }),
      applyBundle: trpc.procedure.input(deviceBundleApplyInputSchema).mutation(async ({ input }) => ({
        kind: input.kind,
        ...await application.devices.importBundleForServer(HUMAN_REQUEST_CONTEXT, input.data, input.hardwareId, input.serverId)
      }))
    }),
    projects: trpc.router({
      current: trpc.procedure.input(emptyInput).query(() => application.projects.document(HUMAN_REQUEST_CONTEXT)),
      chooseFolder: trpc.procedure.input(emptyInput).mutation(async () => {
        const rootPath = await dialogs.chooseProjectFolder();
        return rootPath ? await application.projects.inspectFolder(HUMAN_REQUEST_CONTEXT, rootPath) : null;
      }),
      openFolder: trpc.procedure.input(projectRootPathInputSchema).mutation(async ({ input }) => (
        await application.projects.openFolder(HUMAN_REQUEST_CONTEXT, input.id)
      )),
      initializeFolder: trpc.procedure.input(projectRootPathInputSchema).mutation(async ({ input }) => (
        await application.projects.initializeFolder(HUMAN_REQUEST_CONTEXT, input.id)
      )),
      save: trpc.procedure.input(emptyInput).mutation(async () => application.projects.saveProject(HUMAN_REQUEST_CONTEXT)),
      leave: trpc.procedure.input(emptyInput).mutation(async () => {
        await application.projects.leaveProject(HUMAN_REQUEST_CONTEXT);
      }),
      listRecent: trpc.procedure.input(emptyInput).query(() => application.projects.listRecent(HUMAN_REQUEST_CONTEXT)),
      forgetRecent: trpc.procedure.input(projectRootPathInputSchema).mutation(async ({ input }) => {
        await application.projects.forgetRecent(HUMAN_REQUEST_CONTEXT, input.id);
      })
    }),
    wiring: trpc.router({
      update: trpc.procedure.input(projectWiringSchema).mutation(({ input }) => notifyProject(application.wiring.updateDocument(HUMAN_REQUEST_CONTEXT, input), false)),
      requestTask: trpc.procedure.input(requestWiringTaskInputSchema).mutation(({ input }) => application.wiring.requestTask(HUMAN_REQUEST_CONTEXT, input)),
      startTask: trpc.procedure.input(z.object({ id: z.string().min(1), operatorName: z.string().min(1).optional() }).strict())
        .mutation(({ input }) => application.wiring.startTask(HUMAN_REQUEST_CONTEXT, input.id, input.operatorName)),
      completeTask: trpc.procedure.input(z.object({ id: z.string().min(1), outcome: wiringOutcomeSchema, message: z.string().optional() }).strict())
        .mutation(({ input }) => application.wiring.completeTask(HUMAN_REQUEST_CONTEXT, input.id, input.outcome, input.message)),
      cancelTask: trpc.procedure.input(z.object({ id: z.string().min(1), message: z.string().optional() }).strict())
        .mutation(({ input }) => application.wiring.cancelTask(HUMAN_REQUEST_CONTEXT, input.id, input.message)),
      getTask: trpc.procedure.input(wiringTaskIdInputSchema).query(({ input }) => application.wiring.getTask(HUMAN_REQUEST_CONTEXT, input.id)),
      listTasks: trpc.procedure.input(wiringTaskListQuerySchema.optional()).query(({ input }) => application.wiring.listTasks(
        HUMAN_REQUEST_CONTEXT,
        input === undefined ? undefined : {
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.limit === undefined ? {} : { limit: input.limit })
        }
      ))
    }),
    orchestration: trpc.router({
      updateTask: trpc.procedure.input(testTaskSchema).mutation(({ input }) => notifyProject(application.orchestration.updateTask(HUMAN_REQUEST_CONTEXT, input).document, false)),
      validateTask: trpc.procedure.input(testTaskSchema).query(({ input }) => application.orchestration.validateTask(HUMAN_REQUEST_CONTEXT, input)),
      startRun: trpc.procedure.input(z.object({ inputs: z.record(z.unknown()).optional() }).strict().optional())
        .mutation(({ input }) => application.orchestration.startRun(
          HUMAN_REQUEST_CONTEXT,
          input?.inputs === undefined ? undefined : { inputs: input.inputs }
        )),
      cancelRun: trpc.procedure.input(runIdInputSchema).mutation(({ input }) => application.orchestration.cancelRun(HUMAN_REQUEST_CONTEXT, input.id)),
      getRun: trpc.procedure.input(z.object({
        id: z.string().min(1), sinceEventId: z.number().int().min(0).default(0), nodeOffset: z.number().int().min(0).default(0),
        nodeLimit: z.number().int().min(1).max(1000).default(200)
      }).strict()).query(({ input }) => application.orchestration.getRun(HUMAN_REQUEST_CONTEXT, input.id, input.sinceEventId, input.nodeOffset, input.nodeLimit)),
      listRuns: trpc.procedure.input(testRunListQuerySchema.optional()).query(({ input }) => application.orchestration.listRuns(HUMAN_REQUEST_CONTEXT, input)),
      exportRun: trpc.procedure.input(runIdInputSchema).query(({ input }) => application.orchestration.exportRun(HUMAN_REQUEST_CONTEXT, input.id)),
      deleteRun: trpc.procedure.input(runIdInputSchema).mutation(({ input }) => application.orchestration.deleteRun(HUMAN_REQUEST_CONTEXT, input.id)),
      clearCompletedRuns: trpc.procedure.input(emptyInput).mutation(() => application.orchestration.clearCompletedRuns(HUMAN_REQUEST_CONTEXT)),
      listOperatorDecisions: trpc.procedure.input(emptyInput).query(() => application.orchestration.listOperatorDecisions(HUMAN_REQUEST_CONTEXT)),
      respondOperatorDecision: trpc.procedure.input(z.object({ id: z.string().min(1), value: z.string() }).strict())
        .mutation(({ input }) => application.orchestration.respondOperatorDecision(HUMAN_REQUEST_CONTEXT, input.id, input.value))
    }),
    manual: trpc.router({
      invokeTool: trpc.procedure.input(manualToolInvocationInputSchema).mutation(({ input }) => application.manual.invokeTool(HUMAN_REQUEST_CONTEXT, input))
    }),
    occupancy: trpc.router({
      list: trpc.procedure.input(emptyInput).query(() => application.occupancy.list(HUMAN_REQUEST_CONTEXT)),
      acquire: trpc.procedure.input(occupancyHardwareIdInputSchema).mutation(({ input }) => application.occupancy.acquire(HUMAN_REQUEST_CONTEXT, input.hardwareId)),
      release: trpc.procedure.input(occupancyHardwareIdInputSchema).mutation(({ input }) => application.occupancy.release(HUMAN_REQUEST_CONTEXT, input.hardwareId)),
      listRequests: trpc.procedure.input(occupancyRequestListQuerySchema.optional()).query(({ input }) => application.occupancy.listRequests(
        HUMAN_REQUEST_CONTEXT,
        input === undefined ? undefined : {
          limit: input.limit,
          ...(input.status === undefined ? {} : { status: input.status })
        }
      )),
      acquireRequest: trpc.procedure.input(occupancyRequestIdInputSchema).mutation(({ input }) => application.occupancy.acquireRequest(HUMAN_REQUEST_CONTEXT, input.id)),
      rejectRequest: trpc.procedure.input(z.object({ id: z.string().min(1), message: z.string().optional() }).strict())
        .mutation(({ input }) => application.occupancy.rejectRequest(HUMAN_REQUEST_CONTEXT, input.id, input.message)),
      cancelRequest: trpc.procedure.input(z.object({ id: z.string().min(1), message: z.string().optional() }).strict())
        .mutation(({ input }) => application.occupancy.cancelRequest(HUMAN_REQUEST_CONTEXT, input.id, input.message))
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
