import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PinPair, PortSide, ProjectWiring } from "@hardwareharness/contracts/wiring";
import { useDeviceCatalog, useProjectDocument } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import {
  DEFAULT_CARD_HEIGHT,
  DEFAULT_CARD_WIDTH,
  clampCardHeight,
  clampCardWidth,
  clampOffset,
  defaultPortPositions,
  touchesHardware
} from "./wiring-model.js";

/**
 * The wiring slice of the shared project document plus every edit the workbench can make.
 * Layout and structural edits both go through `wiring.update`; the main process decides what
 * marks the project dirty.
 */
export function useWiringDocument() {
  const client = useQueryClient();
  const project = useProjectDocument();
  const catalog = useDeviceCatalog();
  const save = useMutation({
    scope: { id: "wiring-document" },
    mutationFn: (next: ProjectWiring) => window.hardwareharness.wiring.updateDocument({ wiring: next }),
    onSuccess: (doc) => { client.setQueryData(queryKeys.projectDocument, doc); }
  });

  const wiring = project.data?.file.wiring;
  const hardware = useMemo(() => catalog.data?.hardware ?? [], [catalog.data]);
  // `useMutation` returns a fresh object every render, but `mutate` is referentially stable.
  // Depending on the object here would churn every memo below it and loop `setNodes`.
  const persist = save.mutate;

  const mapNodes = useCallback((
    hardwareId: string,
    update: (node: ProjectWiring["nodes"][number]) => ProjectWiring["nodes"][number]
  ) => {
    if (!wiring) return;
    persist({ ...wiring, nodes: wiring.nodes.map((node) => node.hardwareId === hardwareId ? update(node) : node) });
  }, [persist, wiring]);

  const addNode = useCallback((hardwareId: string, position?: { x: number; y: number }) => {
    if (!wiring || wiring.nodes.some((item) => item.hardwareId === hardwareId)) return;
    const index = wiring.nodes.length;
    const ports = hardware.find((item) => item.hardwareId === hardwareId)?.ports.map((item) => item.portId) ?? [];
    persist({
      ...wiring,
      nodes: [...wiring.nodes, {
        hardwareId,
        x: position?.x ?? 80 + (index % 3) * 330,
        y: position?.y ?? 80 + Math.floor(index / 3) * 240,
        width: DEFAULT_CARD_WIDTH,
        height: DEFAULT_CARD_HEIGHT,
        portPositions: defaultPortPositions(ports)
      }]
    });
  }, [hardware, persist, wiring]);

  const removeNode = useCallback((hardwareId: string) => {
    if (!wiring) return;
    persist({
      ...wiring,
      nodes: wiring.nodes.filter((entry) => entry.hardwareId !== hardwareId),
      connections: wiring.connections.filter((entry) => !touchesHardware(entry, hardwareId))
    });
  }, [persist, wiring]);

  const moveNode = useCallback((hardwareId: string, x: number, y: number) => {
    mapNodes(hardwareId, (node) => ({ ...node, x, y }));
  }, [mapNodes]);

  const movePort = useCallback((hardwareId: string, portId: string, side: PortSide, offset: number) => {
    mapNodes(hardwareId, (node) => ({
      ...node,
      portPositions: { ...node.portPositions, [portId]: { side, offset: clampOffset(offset) } }
    }));
  }, [mapNodes]);

  const resizeNode = useCallback((hardwareId: string, width: number, height: number) => {
    mapNodes(hardwareId, (node) => ({
      ...node,
      width: clampCardWidth(width),
      height: clampCardHeight(height)
    }));
  }, [mapNodes]);

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
      addNode, removeNode, moveNode, movePort, resizeNode,
      removeConnection, createConnection, updateConnectionPins
    }
  };
}

type WiringEdits = ReturnType<typeof useWiringDocument>["edits"];
