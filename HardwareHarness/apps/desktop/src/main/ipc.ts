import { initTRPC } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { agentKindSchema } from "@hardwareharness/contracts/agents";
import type { HardwareHarnessAgentsApi, HardwareHarnessSettingsApi } from "@hardwareharness/contracts/desktop";
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
} from "@hardwareharness/contracts/devices";
import { toWireError } from "@hardwareharness/contracts/errors";
import { manualToolInvocationInputSchema } from "@hardwareharness/contracts/execution";

import { projectRootPathInputSchema, type ProjectDocument } from "@hardwareharness/contracts/projects";
import { llmSettingsInputSchema, projectViewSchema, themeChoiceSchema, welcomeLayoutSchema } from "@hardwareharness/contracts/storage";
import {
  projectWiringSchema,
  requestWiringTaskInputSchema,
  wiringOutcomeSchema,
  wiringTaskIdInputSchema,
  wiringTaskListQuerySchema
} from "@hardwareharness/contracts/wiring";
import { DESKTOP_HUMAN_CONTEXT as HUMAN_REQUEST_CONTEXT, type PythonApplication } from "./python-application.js";
import { testPlanOperationSchema, testPlanSchema } from "@hardwareharness/contracts/testing";
import { hardwareHarnessTransformer } from "../shared/trpc-transformer.js";
import type { DesktopEventListener } from "./desktop-events.js";

interface DesktopDialogsPort {
  exportText(defaultPath: string, content: string): Promise<string | null>;
  chooseHardwareImage(): Promise<string | null>;
  saveBundle(kind: DeviceBundleKind, id: string, data: Uint8Array): Promise<DeviceBundleExport | null>;
  openBundle(kind: DeviceBundleKind): Promise<Uint8Array | null>;
  chooseProjectFolder(): Promise<string | null>;
}

type DesktopEventName = "availability" | "execution" | "wiringTask" | "workspace" | "application" | "project" | "testPlan" | "testRun" | "opencode" | "window-state";

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
  workspaceChanged(): Promise<void>;
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
const eventNameSchema = z.enum(["availability", "execution", "wiringTask", "workspace", "application", "project", "testPlan", "testRun", "opencode", "window-state"]);

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
        .query(({ input }) => `hardwareharness-asset://local/${encodeURIComponent(input.hardwareId)}/${input.assetId.split("/").map(encodeURIComponent).join("/")}`),
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
      update: trpc.procedure.input(projectWiringSchema).mutation(async ({ input }) => notifyProject(await application.wiring.updateDocument(HUMAN_REQUEST_CONTEXT, input), false)),
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
    manual: trpc.router({
      invokeTool: trpc.procedure.input(manualToolInvocationInputSchema).mutation(({ input }) => application.manual.invokeTool(HUMAN_REQUEST_CONTEXT, input))
    }),
    testing: trpc.router({
      listPlans: trpc.procedure.input(emptyInput).query(() => application.testing.listPlans(HUMAN_REQUEST_CONTEXT)),
      loadPlan: trpc.procedure.input(z.object({ planId: z.string().min(1) }).strict()).query(({ input }) => application.testing.loadPlan(HUMAN_REQUEST_CONTEXT, input.planId)),
      createPlan: trpc.procedure.input(z.object({ requestId: z.string().min(1), id: z.string().min(1).optional(), name: z.string().min(1), description: z.string().optional(), parameters: z.array(z.unknown()).optional() }).strict()).mutation(({ input }) => application.testing.createPlan(HUMAN_REQUEST_CONTEXT, input)),
      savePlan: trpc.procedure.input(z.object({ plan: testPlanSchema, baseRevision: z.number().int().positive() }).strict()).mutation(({ input }) => application.testing.savePlan(HUMAN_REQUEST_CONTEXT, input.plan, input.baseRevision)),
      deletePlan: trpc.procedure.input(z.object({ planId: z.string().min(1) }).strict()).mutation(async ({ input }) => { await application.testing.deletePlan(HUMAN_REQUEST_CONTEXT, input.planId); }),
      applyPlanOperations: trpc.procedure.input(z.object({ planId: z.string().min(1), baseRevision: z.number().int().positive(), requestId: z.string().min(1), operations: z.array(testPlanOperationSchema) }).strict()).mutation(({ input }) => application.testing.applyPlanOperations(HUMAN_REQUEST_CONTEXT, input)),
      validatePlan: trpc.procedure.input(z.object({ planId: z.string().min(1) }).strict()).query(({ input }) => application.testing.validatePlan(HUMAN_REQUEST_CONTEXT, input.planId)),
      analyzePlanDraft: trpc.procedure.input(z.object({ plan: testPlanSchema, baseRevision: z.number().int().positive() }).strict()).query(({ input }) => application.testing.analyzePlanDraft(HUMAN_REQUEST_CONTEXT, input)),
      listStepCatalog: trpc.procedure.input(emptyInput).query(() => application.testing.listStepCatalog(HUMAN_REQUEST_CONTEXT)),
      listDeviceTools: trpc.procedure.input(z.object({ hardwareId: z.string().min(1) }).strict()).query(({ input }) => application.testing.listDeviceTools(HUMAN_REQUEST_CONTEXT, input.hardwareId)),
      startRun: trpc.procedure.input(z.object({ planId: z.string().min(1), revision: z.number().int().positive(), executionRevision: z.string().min(1), requestId: z.string().min(1), parameters: z.record(z.unknown()) }).strict()).mutation(({ input }) => application.testing.startRun(HUMAN_REQUEST_CONTEXT, input)),
      pauseRun: trpc.procedure.input(z.object({ runId: z.string().min(1) }).strict()).mutation(({ input }) => application.testing.pauseRun(HUMAN_REQUEST_CONTEXT, input.runId)),
      resumeRun: trpc.procedure.input(z.object({ runId: z.string().min(1) }).strict()).mutation(({ input }) => application.testing.resumeRun(HUMAN_REQUEST_CONTEXT, input.runId)),
      abortRun: trpc.procedure.input(z.object({ runId: z.string().min(1) }).strict()).mutation(({ input }) => application.testing.abortRun(HUMAN_REQUEST_CONTEXT, input.runId)),
      currentRun: trpc.procedure.input(emptyInput).query(() => application.testing.currentRun(HUMAN_REQUEST_CONTEXT)),
      getRun: trpc.procedure.input(z.object({ runId: z.string().min(1) }).strict()).query(({ input }) => application.testing.getRun(HUMAN_REQUEST_CONTEXT, input.runId)),
      listRuns: trpc.procedure.input(z.object({ cursor: z.string().min(1).optional(), limit: z.number().int().min(1).max(200).optional(), planId: z.string().min(1).optional(), verdict: z.enum(["NotSet", "Pass", "Inconclusive", "Fail", "Aborted", "Error"]).optional(), state: z.enum(["starting", "running", "paused", "cleaning", "completed", "aborted", "error"]).optional(), from: z.string().optional(), to: z.string().optional() }).strict().optional()).query(({ input }) => application.testing.listRuns(HUMAN_REQUEST_CONTEXT, input)),
      readRunLog: trpc.procedure.input(z.object({ runId: z.string().min(1), afterEventSequence: z.number().int().min(0).optional(), afterResultSequence: z.number().int().min(0).optional(), eventLimit: z.number().int().min(1).max(5000).optional(), resultLimit: z.number().int().min(1).max(5000).optional() }).strict()).query(({ input }) => application.testing.readRunLog(HUMAN_REQUEST_CONTEXT, input.runId, input.afterEventSequence, input.afterResultSequence, input.eventLimit, input.resultLimit)),
      readRunResults: trpc.procedure.input(z.object({ runId: z.string().min(1), afterSequence: z.number().int().min(0).optional() }).strict()).query(({ input }) => application.testing.readRunResults(HUMAN_REQUEST_CONTEXT, input.runId, input.afterSequence)),
      listRecoveryItems: trpc.procedure.input(emptyInput).query(() => application.testing.listRecoveryItems(HUMAN_REQUEST_CONTEXT)),
      reconcileOperation: trpc.procedure.input(z.object({ operationId: z.string().min(1), resolution: z.enum(["confirmed_succeeded", "confirmed_failed", "safe_state_restored"]), note: z.string().optional() }).strict()).mutation(({ input }) => application.testing.reconcileOperation(HUMAN_REQUEST_CONTEXT, { operationId: input.operationId, resolution: input.resolution, ...(input.note === undefined ? {} : { note: input.note }) }))
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
