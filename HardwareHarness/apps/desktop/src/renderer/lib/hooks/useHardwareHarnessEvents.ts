import { useEffect, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { subscribeInvalidations } from "../event-invalidation.js";

/** Keep TanStack Query in step with the backend's change events (design §9.6.3). */
export function useHardwareHarnessEvents(client: QueryClient) {
  const clientRef = useRef(client);
  clientRef.current = client;

  useEffect(() => subscribeInvalidations(
    (event, listener) => window.hardwareharness.events.subscribe(event, listener),
    (key) => void (key === "all"
      ? clientRef.current.invalidateQueries()
      : clientRef.current.invalidateQueries({ queryKey: key }))
  ), []);
}
