import { useEffect, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { ProjectDocument } from "@hardwareharness/contracts/projects";
import { queryKeys } from "../query-keys.js";

export function useHardwareHarnessEvents(client: QueryClient) {
  const clientRef = useRef(client);
  clientRef.current = client;

  useEffect(() => {
    const c = () => clientRef.current;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const debouncedInvalidate = (...keys: readonly (readonly string[])[]) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        for (const key of keys) void c().invalidateQueries({ queryKey: key });
      }, 100);
    };

    const stops = [
      window.hardwareharness.events.subscribe("availability", () => {
        void c().invalidateQueries({ queryKey: queryKeys.dashboard });
      }),
      window.hardwareharness.events.subscribe("execution", () => {
        void c().invalidateQueries({ queryKey: queryKeys.dashboard });
      }),
      window.hardwareharness.events.subscribe("project", (payload) => {
        c().setQueryData(queryKeys.projectDocument, payload as ProjectDocument | null);
        void c().invalidateQueries({ queryKey: queryKeys.wiringTasks });
      }),
      window.hardwareharness.events.subscribe("wiringTask", () => {
        debouncedInvalidate(queryKeys.wiringTasks, queryKeys.projectDocument);
      }),
      window.hardwareharness.events.subscribe("testPlan", () => {
        void c().invalidateQueries({ queryKey: queryKeys.testPlans });
      }),
      window.hardwareharness.events.subscribe("testRun", () => {
        void c().invalidateQueries({ queryKey: queryKeys.testRun });
        void c().invalidateQueries({ queryKey: queryKeys.dashboard });
      }),
    ];

    const fallback = window.setInterval(() => {
      void c().invalidateQueries({ queryKey: queryKeys.wiringTasks });
    }, 15_000);

    return () => {
      for (const stop of stops) stop();
      window.clearInterval(fallback);
      clearTimeout(debounceTimer);
    };
  }, []);
}
