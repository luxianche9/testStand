/**
 * App-wide command bus. The command palette and shortcuts dispatch commands as DOM events so
 * feature pages can handle the ones they own (run selected test items, new connection, …)
 * without the shell importing them.
 */
export type AppCommandId =
  | "testing.run-selected"
  | "testing.new-item"
  | "wiring.new-connection";

const EVENT = "teststand:command";

export function dispatchAppCommand(id: AppCommandId): boolean {
  const event = new CustomEvent<AppCommandId>(EVENT, { detail: id, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Subscribe a page to a command. Call `event.preventDefault()` semantics are handled here. */
export function onAppCommand(id: AppCommandId, handler: () => void): () => void {
  const listener = (event: Event) => {
    if ((event as CustomEvent<AppCommandId>).detail !== id) return;
    event.preventDefault();
    handler();
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
