import { useEffect, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { subscribeInvalidations } from "../event-invalidation.js";

/** Keep TanStack Query in step with the backend's change events (design §9.6.3), and flash the
 *  taskbar entry when the Agent asks for a wiring change. */
export function useTestStandEvents(client: QueryClient) {
  const clientRef = useRef(client);
  clientRef.current = client;

  useEffect(() => window.teststand.events.subscribe("wiringTask", (payload) => {
    if ((payload as { status?: string } | null)?.status === "pending") void window.teststand.window.flash();
  }), []);

  useEffect(() => subscribeInvalidations(
    (event, listener) => window.teststand.events.subscribe(event, listener),
    (key) => void (key === "all"
      ? clientRef.current.invalidateQueries()
      : clientRef.current.invalidateQueries({ queryKey: key }))
  ), []);
}
