import { useCallback, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SignalLink, SignalNode, SignalView, SignalWidget } from "@teststand/contracts/signals";
import { useProjectDocument } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import { WIDGET_SIZES, newId } from "./signal-model.js";

const EMPTY: SignalView = { nodes: [], links: [] };
const MIN_SIZE = 80;

/**
 * The signal view of the shared project document plus every edit the canvas makes. Edits go
 * through `signals.updateDocument`: moved or resized nodes are saved at once, structural edits stay
 * in the project buffer until the project is saved.
 */
export function useSignalDocument() {
  const client = useQueryClient();
  const project = useProjectDocument();
  const save = useMutation({
    scope: { id: "signal-document" },
    mutationFn: (next: SignalView) => window.teststand.signals.updateDocument({ signals: next }),
    onSuccess: (doc) => { client.setQueryData(queryKeys.projectDocument, doc); }
  });
  const view = project.data?.file.signals ?? EMPTY;
  // Edits made before the previous one came back build on it, not on the stale query data.
  const latest = useRef(view);
  latest.current = save.isPending && save.variables ? save.variables : view;
  const persist = save.mutate;
  const apply = useCallback((change: (current: SignalView) => SignalView) => {
    const next = change(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    persist(next);
  }, [persist]);

  const mapNode = useCallback((nodeId: string, update: (node: SignalNode) => SignalNode) => {
    apply((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.nodeId === nodeId ? update(node) : node)
    }));
  }, [apply]);

  const addHardware = useCallback((hardwareId: string, x: number, y: number) => {
    apply((current) => current.nodes.some((node) => node.kind === "hardware" && node.hardwareId === hardwareId)
      ? current
      : { ...current, nodes: [...current.nodes, { nodeId: newId("hw"), kind: "hardware", hardwareId, x, y }] });
  }, [apply]);

  const addWidget = useCallback((widget: SignalWidget, x: number, y: number): string => {
    const nodeId = newId("w");
    apply((current) => ({
      ...current,
      nodes: [
        ...current.nodes,
        { nodeId, kind: "widget", widget, label: "", config: {}, x, y, ...WIDGET_SIZES[widget] }
      ]
    }));
    return nodeId;
  }, [apply]);

  const moveNode = useCallback((nodeId: string, x: number, y: number) => {
    mapNode(nodeId, (node) => ({ ...node, x: Math.round(x), y: Math.round(y) }));
  }, [mapNode]);

  const resizeNode = useCallback((nodeId: string, width: number, height: number) => {
    mapNode(nodeId, (node) => ({
      ...node, width: Math.max(MIN_SIZE, Math.round(width)), height: Math.max(MIN_SIZE, Math.round(height))
    }));
  }, [mapNode]);

  const removeNode = useCallback((nodeId: string) => {
    apply((current) => ({
      nodes: current.nodes.filter((node) => node.nodeId !== nodeId),
      links: current.links.filter((link) => link.from.nodeId !== nodeId && link.to.nodeId !== nodeId)
    }));
  }, [apply]);

  const updateWidget = useCallback((nodeId: string, patch: { label?: string; config?: Record<string, unknown> }) => {
    mapNode(nodeId, (node) => node.kind === "widget"
      ? {
          ...node,
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          config: { ...node.config, ...patch.config }
        }
      : node);
  }, [mapNode]);

  const addLink = useCallback((link: Pick<SignalLink, "from" | "to">) => {
    apply((current) => ({ ...current, links: [...current.links, { linkId: newId("ln"), ...link }] }));
  }, [apply]);

  const removeLinks = useCallback((linkIds: string[]) => {
    const removed = new Set(linkIds);
    apply((current) => ({ ...current, links: current.links.filter((link) => !removed.has(link.linkId)) }));
  }, [apply]);

  const replace = useCallback((next: SignalView) => apply(() => next), [apply]);

  return {
    project,
    view,
    save,
    edits: { addHardware, addWidget, moveNode, resizeNode, removeNode, updateWidget, addLink, removeLinks, replace }
  };
}

export type SignalEdits = ReturnType<typeof useSignalDocument>["edits"];
