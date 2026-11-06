import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProtocolBinding } from "@teststand/contracts/projects";
import { queryKeys } from "../../lib/query-keys.js";

/** One change of `protocols.update`, applied in order by the backend. */
export type ProtocolOperation =
  | ({ op: "add" } & ProtocolBinding)
  | { op: "update"; alias: string; icd?: string; source?: ProtocolBinding["source"] }
  | { op: "remove"; alias: string };

/**
 * The project's protocol bindings with their state; refetched on `project` events. When they change (the
 * Agent bound a protocol, say), the devices' stream lists are refetched too: they include the protocol
 * fields. Refetching those on every project event would disturb the monitor while it saves its layout.
 */
export function useProtocolBindings() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.protocols, queryFn: () => window.teststand.protocols.list() });
  const seen = useRef<string>(undefined);
  const signature = query.data ? JSON.stringify(query.data) : undefined;
  useEffect(() => {
    if (signature === undefined) return;
    if (seen.current !== undefined && seen.current !== signature) {
      void client.invalidateQueries({ queryKey: queryKeys.monitorStreams });
    }
    seen.current = signature;
  }, [client, signature]);
  return query;
}

/** Changes the bindings; the devices' stream lists follow (they include the protocol fields). */
export function useUpdateProtocols() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (operations: ProtocolOperation[]) => window.teststand.protocols.update({ input: { operations } }),
    onSuccess: async (bindings) => {
      client.setQueryData(queryKeys.protocols, bindings);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.monitorStreams }),
        client.invalidateQueries({ queryKey: queryKeys.projectDocument })
      ]);
    }
  });
}
