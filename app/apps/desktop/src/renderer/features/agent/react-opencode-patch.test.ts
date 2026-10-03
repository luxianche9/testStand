import type { OpencodeClient } from "@assistant-ui/react-opencode";
import {
  OpenCodeThreadController,
  createOpenCodeThreadState,
  reduceOpenCodeThreadState
} from "@assistant-ui/react-opencode";
import { describe, expect, it, vi } from "vitest";

describe("react-opencode failure recovery patch", () => {
  it("settles the session status after an asynchronous run failure", () => {
    const started = reduceOpenCodeThreadState(createOpenCodeThreadState("ses_1"), { type: "run.started" });
    const failed = reduceOpenCodeThreadState(started, { type: "run.failed", error: new Error("ENOENT") });

    expect(failed.runState.type).toBe("error");
    expect(failed.sessionStatus).toEqual({ type: "idle" });
  });

  it("settles the session status when promptAsync rejects", () => {
    const queued = reduceOpenCodeThreadState(
      reduceOpenCodeThreadState(createOpenCodeThreadState("ses_1"), { type: "run.started" }),
      {
        type: "local.message.queued",
        pending: {
          clientId: "local_1",
          sessionId: "ses_1",
          createdAt: 1,
          parentId: null,
          sourceId: null,
          runConfig: undefined,
          parts: [{ type: "text", text: "hello" }],
          contentText: "hello",
          status: "pending"
        }
      }
    );
    const failed = reduceOpenCodeThreadState(queued, {
      type: "local.message.failed",
      clientId: "local_1",
      error: new Error("request failed")
    });

    expect(failed.runState.type).toBe("error");
    expect(failed.sessionStatus).toEqual({ type: "idle" });
  });

  it("settles cancellation immediately after abort succeeds", async () => {
    const abort = vi.fn(async () => ({ data: true }));
    const client = { session: { abort } } as unknown as OpencodeClient;
    const controller = new OpenCodeThreadController(
      client,
      () => ({ subscribe: () => () => undefined }),
      "ses_1"
    );

    await controller.cancel();

    expect(abort).toHaveBeenCalled();
    expect(controller.getState().runState).toEqual({ type: "idle" });
    expect(controller.getState().sessionStatus).toEqual({ type: "idle" });
  });
});
