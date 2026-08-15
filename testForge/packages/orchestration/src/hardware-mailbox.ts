import { createActor, fromCallback } from "xstate";

type MailboxEvent = {
  type: "EXECUTE";
  operation: () => Promise<unknown>;
  signal: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const hardwareMailboxLogic = fromCallback<MailboxEvent>(({ receive }) => {
  const queue: MailboxEvent[] = [];
  let running = false;
  let stopped = false;

  const drain = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && queue.length > 0) {
        const event = queue.shift()!;
        if (event.signal.aborted) {
          event.reject(event.signal.reason ?? abortError("Hardware operation cancelled while queued"));
          continue;
        }
        try { event.resolve(await event.operation()); }
        catch (error) { event.reject(error); }
      }
    } finally { running = false; }
  };

  receive((event) => {
    queue.push(event);
    void drain();
  });

  return () => {
    stopped = true;
    for (const event of queue.splice(0)) event.reject(abortError("Hardware mailbox stopped"));
  };
});

export class HardwareMailbox {
  private readonly actor = createActor(hardwareMailboxLogic);

  constructor() { this.actor.start(); }

  async execute<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      this.actor.send({
        type: "EXECUTE",
        operation,
        signal,
        resolve: (value) => resolve(value as T),
        reject
      });
    });
  }

  stop(): void { this.actor.stop(); }
}

function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: "AbortError" });
}
