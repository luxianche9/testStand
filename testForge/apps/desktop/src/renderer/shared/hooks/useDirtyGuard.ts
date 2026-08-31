import { useCallback, useEffect, useState } from "react";
import type { ProjectDocument } from "@testforge/contracts/projects";
import { errorMessage } from "../errors.js";

export type PendingAction = { run: () => Promise<void>; label: string };

export function useDirtyGuard(
  dirty: boolean,
  save: () => Promise<ProjectDocument>,
  syncProject: (document?: ProjectDocument | null) => Promise<void>,
  onError: (message: string) => void,
) {
  const [pending, setPending] = useState<PendingAction>();

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const guard = useCallback((label: string, run: () => Promise<void>) => {
    if (!dirty) { void run(); return; }
    setPending({ label, run });
  }, [dirty]);

  const continuePending = useCallback(async (saveFirst: boolean) => {
    if (!pending) return;
    try {
      if (saveFirst) {
        const document = await save();
        await syncProject(document);
      }
      const action = pending;
      setPending(undefined);
      await action.run();
    } catch (reason) {
      onError(errorMessage(reason));
    }
  }, [onError, pending, save, syncProject]);

  const clearPending = useCallback(() => setPending(undefined), []);

  return { guard, pending, continuePending, clearPending };
}
