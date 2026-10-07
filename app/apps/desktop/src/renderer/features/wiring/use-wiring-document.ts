import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PinPair, ProjectWiring } from "@teststand/contracts/wiring";
import { useDeviceCatalog, useProjectDocument } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import { touchesHardware } from "./wiring-model.js";

/**
 * The physical wiring of the shared project document (pin connections) plus every edit the pin
 * list can make. Edits go to the project buffer through `wiring.updateDocument`.
 */
export function useWiringDocument() {
  const client = useQueryClient();
  const project = useProjectDocument();
  const catalog = useDeviceCatalog();
  const save = useMutation({
    scope: { id: "wiring-document" },
    mutationFn: (next: ProjectWiring) => window.teststand.wiring.updateDocument({ wiring: next }),
    onSuccess: (doc) => { client.setQueryData(queryKeys.projectDocument, doc); }
  });

  const wiring = project.data?.file.wiring;
  const hardware = useMemo(() => catalog.data?.hardware ?? [], [catalog.data]);
  // `useMutation` returns a fresh object every render, but `mutate` is referentially stable.
  // Depending on the object here would churn every memo below it and loop `setNodes`.
  const persist = save.mutate;

  /** Drops every cable that touches the hardware (before the hardware itself is removed). */
  const removeHardwareConnections = useCallback((hardwareId: string) => {
    if (!wiring) return;
    persist({ ...wiring, connections: wiring.connections.filter((entry) => !touchesHardware(entry, hardwareId)) });
  }, [persist, wiring]);

  const removeConnection = useCallback((connectionId: string) => {
    if (!wiring) return;
    persist({ ...wiring, connections: wiring.connections.filter((item) => item.connectionId !== connectionId) });
  }, [persist, wiring]);

  const createConnection = useCallback((portA: string, portB: string, pins: PinPair[]) => {
    if (!wiring) return;
    persist({
      ...wiring,
      connections: [...wiring.connections, {
        connectionId: crypto.randomUUID(), portA, portB, pins,
        confirmedAt: new Date().toISOString(), confirmedBy: "user"
      }]
    });
  }, [persist, wiring]);

  const updateConnectionPins = useCallback((connectionId: string, pins: PinPair[]) => {
    if (!wiring) return;
    persist({
      ...wiring,
      connections: wiring.connections.map((item) => item.connectionId === connectionId ? { ...item, pins } : item)
    });
  }, [persist, wiring]);

  return {
    project,
    catalog,
    save,
    wiring,
    hardware,
    edits: {
      removeHardwareConnections, removeConnection, createConnection, updateConnectionPins
    }
  };
}

type WiringEdits = ReturnType<typeof useWiringDocument>["edits"];
