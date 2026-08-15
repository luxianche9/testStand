import { assign, createActor, setup, type ActorRefFrom, type SnapshotFrom } from "xstate";

type RunMachinePhase = "main" | "cleanup";

interface RunMachineContext {
  runId: string;
  phase: RunMachinePhase;
  workflowContext: Record<string, unknown>;
  message: string | undefined;
}

interface RunMachineInput {
  runId: string;
  phase: RunMachinePhase;
  workflowContext: Record<string, unknown>;
}

type RunMachineEvent =
  | { type: "CHECKPOINT"; phase: RunMachinePhase; workflowContext: Record<string, unknown> }
  | { type: "CANCEL" }
  | { type: "PASS"; message?: string }
  | { type: "FAIL"; message?: string }
  | { type: "COMPLETE_CANCEL"; message?: string }
  | { type: "INTERRUPT"; message?: string };

const runMachine = setup({
  types: {
    context: {} as RunMachineContext,
    events: {} as RunMachineEvent,
    input: {} as RunMachineInput
  },
  actions: {
    checkpoint: assign(({ event }) => event.type === "CHECKPOINT"
      ? { phase: event.phase, workflowContext: structuredClone(event.workflowContext) }
      : {}),
    rememberMessage: assign(({ event }) => "message" in event ? { message: event.message } : {})
  }
}).createMachine({
  id: "testforge-run",
  context: ({ input }) => ({
    runId: input.runId,
    phase: input.phase,
    workflowContext: structuredClone(input.workflowContext),
    message: undefined
  }),
  initial: "running",
  on: {
    CHECKPOINT: { actions: "checkpoint" }
  },
  states: {
    running: {
      on: {
        CANCEL: "cancelling",
        PASS: { target: "passed", actions: "rememberMessage" },
        FAIL: { target: "failed", actions: "rememberMessage" },
        COMPLETE_CANCEL: { target: "cancelled", actions: "rememberMessage" },
        INTERRUPT: { target: "interrupted", actions: "rememberMessage" }
      }
    },
    cancelling: {
      on: {
        COMPLETE_CANCEL: { target: "cancelled", actions: "rememberMessage" },
        FAIL: { target: "failed", actions: "rememberMessage" },
        INTERRUPT: { target: "interrupted", actions: "rememberMessage" }
      }
    },
    passed: { type: "final" },
    failed: { type: "final" },
    cancelled: { type: "final" },
    interrupted: { type: "final" }
  }
});

export type RunMachineActor = ActorRefFrom<typeof runMachine>;

export function createRunMachineActor(input: RunMachineInput, persistedSnapshot?: unknown): RunMachineActor {
  return persistedSnapshot === undefined
    ? createActor(runMachine, { input })
    : createActor(runMachine, { input, snapshot: persistedSnapshot as SnapshotFrom<typeof runMachine> });
}

export type NodeMachineEvent =
  | { type: "START" }
  | { type: "WAIT_OPERATOR" }
  | { type: "PASS" }
  | { type: "FAIL" }
  | { type: "CANCEL" }
  | { type: "SKIP" };

export const nodeMachine = setup({
  types: { events: {} as NodeMachineEvent }
}).createMachine({
  id: "testforge-node",
  initial: "pending",
  states: {
    pending: { on: { START: "running", SKIP: "skipped", CANCEL: "cancelled" } },
    running: { on: { WAIT_OPERATOR: "waiting_operator", PASS: "passed", FAIL: "failed", CANCEL: "cancelled" } },
    waiting_operator: { on: { PASS: "passed", FAIL: "failed", CANCEL: "cancelled" } },
    passed: { type: "final" },
    failed: { type: "final" },
    cancelled: { type: "final" },
    skipped: { type: "final" }
  }
});
