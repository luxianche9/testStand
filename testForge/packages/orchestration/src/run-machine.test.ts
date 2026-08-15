import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { createRunMachineActor, nodeMachine } from "./run-machine.js";

describe("orchestration state machines", () => {
  it("keeps interruption terminal even when execution completion races afterward", () => {
    const actor = createRunMachineActor({ runId: "RUN1", phase: "main", workflowContext: {} });
    actor.start();
    actor.send({ type: "CANCEL" });
    actor.send({ type: "INTERRUPT", message: "Application shutdown" });
    expect(actor.getSnapshot().value).toBe("interrupted");
    expect(actor.getSnapshot().context.message).toBe("Application shutdown");
  });

  it("restores a persisted active checkpoint", () => {
    const first = createRunMachineActor({ runId: "RUN2", phase: "main", workflowContext: { value: 1 } });
    first.start();
    first.send({ type: "CHECKPOINT", phase: "cleanup", workflowContext: { value: 2 } });
    const restored = createRunMachineActor({ runId: "RUN2", phase: "main", workflowContext: {} }, first.getPersistedSnapshot());
    restored.start();
    expect(restored.getSnapshot()).toMatchObject({ value: "running", context: { phase: "cleanup", workflowContext: { value: 2 } } });
  });

  it("models pending, waiting, skipped and terminal node states", () => {
    const skipped = createActor(nodeMachine);
    skipped.start();
    expect(skipped.getSnapshot().value).toBe("pending");
    skipped.send({ type: "SKIP" });
    expect(skipped.getSnapshot().value).toBe("skipped");

    const operator = createActor(nodeMachine);
    operator.start();
    operator.send({ type: "START" });
    operator.send({ type: "WAIT_OPERATOR" });
    expect(operator.getSnapshot().value).toBe("waiting_operator");
    operator.send({ type: "PASS" });
    expect(operator.getSnapshot().value).toBe("passed");
  });
});
