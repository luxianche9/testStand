export const ASSISTANT_OPEN_KEY = "testforge.assistant-open";

export function readAssistantOpen(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  return storage.getItem(ASSISTANT_OPEN_KEY) === "true";
}

export function writeAssistantOpen(open: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(ASSISTANT_OPEN_KEY, String(open));
}
