import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  monitorChannels, PANEL_SOURCE_TYPES, type Monitor, type MonitorControl, type MonitorPanel, type MonitorUpdateInput,
  type PanelType, type Placement, type StreamRef
} from "@teststand/contracts/monitor";
import type { DeviceStream, RunTimeline, StreamDeclaration, StreamInfo } from "@teststand/contracts/observability";
import type { ProjectDocument } from "@teststand/contracts/projects";
import { useMonitorStreams, useProjectDocument } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";

/** Drag payload of a device stream in the devices panel: `{hardwareId, streamId}` as JSON. */
const STREAM_MIME = "application/x-teststand-stream";
/** The stream's type rides in the MIME type itself: a drop target can read it while dragging. */
const STREAM_TYPE_MIME = "application/x-teststand-stream-type-";
/** Drag payload of a component from the component bar: the panel type. */
export const PANEL_MIME = "application/x-teststand-panel";

/** Starts dragging a stream (from the devices panel or the data-source tree). */
export function startStreamDrag(data: DataTransfer, ref: StreamRef, type: string): void {
  data.setData(STREAM_MIME, JSON.stringify(ref));
  data.setData(`${STREAM_TYPE_MIME}${type.toLowerCase()}`, type);
  data.effectAllowed = "copy";
}

/** The type of the stream being dragged ("" when it did not say); undefined when no stream is. */
export function draggedStreamType(types: readonly string[]): string | undefined {
  if (!types.includes(STREAM_MIME)) return undefined;
  return types.find((item) => item.startsWith(STREAM_TYPE_MIME))?.slice(STREAM_TYPE_MIME.length) ?? "";
}

/** The panel last focused in the workspace, where + puts a stream. */
let focusedPanelId: string | undefined;
export function setFocusedPanel(id: string | undefined): void {
  focusedPanelId = id;
}

const EMPTY: Monitor = { panels: [], layout: null };

export function streamKey(ref: StreamRef): string {
  return `${ref.hardwareId}__${ref.streamId}`;
}

export function readDraggedStream(data: DataTransfer): StreamRef | undefined {
  try {
    const value = JSON.parse(data.getData(STREAM_MIME)) as Partial<StreamRef>;
    return typeof value.hardwareId === "string" && typeof value.streamId === "string"
      ? { hardwareId: value.hardwareId, streamId: value.streamId }
      : undefined;
  } catch {
    return undefined;
  }
}

/** What the panels need of a stream the device declares; live frames carry the rest. */
function declaredStreamInfo(hardwareId: string, stream: DeviceStream | undefined, streamId: string): StreamInfo {
  const declaration = (stream ?? {}) as StreamDeclaration & { rateHz?: number };
  return {
    key: `${hardwareId}__${streamId}`,
    hardwareId,
    streamId,
    type: stream?.type ?? "scalar",
    clock: null,
    count: 0,
    first: null,
    last: null,
    lastI: null,
    watermark: null,
    watermarkTb: null,
    gaps: 0,
    // A sampled stream is drawn as a trace; one published on write holds its level.
    states: declaration.rateHz ? ["sampling"] : [],
    declaration
  };
}

/** Whether a panel of `type` draws a stream of `streamType` (an unknown type: any stream panel). */
export function panelDraws(type: PanelType, streamType: string | undefined): boolean {
  const takes = PANEL_SOURCE_TYPES[type];
  return takes.length > 0 && (!streamType || takes.includes(streamType));
}

export const PANEL_LABELS: Readonly<Record<PanelType, string>> = {
  scope: "示波器",
  digital: "数字量",
  terminal: "终端",
  trace: "总线跟踪",
  values: "数值表",
  gauge: "仪表",
  timeline: "状态时间线",
  register: "状态字",
  xy: "XY 图",
  detail: "报文详情",
  control: "控制面板",
  sources: "数据源",
  inspector: "属性",
  results: "结果",
  messages: "报文"
};

export function panelTitle(panel: Pick<MonitorPanel, "type" | "title">): string {
  return panel.title || PANEL_LABELS[panel.type];
}

/**
 * The project's monitor workspace — its panels, the streams every device offers, and the edits the
 * workspace makes (add or remove a panel, drop a stream on one, save the docking layout). Edits go
 * to the project buffer, like the Agent's.
 */
export function useMonitorWorkspace(timeline: RunTimeline | undefined) {
  const client = useQueryClient();
  const project = useProjectDocument();
  const devices = useMonitorStreams();
  const monitor = project.data?.file.monitor ?? EMPTY;
  const setMonitor = useCallback((next: (current: Monitor) => Monitor) => {
    client.setQueryData<ProjectDocument | null>(queryKeys.projectDocument, (current) => current
      ? { ...current, dirty: true, file: { ...current.file, monitor: next(current.file.monitor) } }
      : current);
  }, [client]);
  const update = useMutation({
    mutationFn: (input: MonitorUpdateInput) => window.teststand.monitor.update({ input }),
    onMutate: (input) => {
      if (input.layout !== undefined) setMonitor((current) => ({ ...current, layout: input.layout ?? null }));
    },
    onSuccess: (result) => setMonitor(() => result),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.projectDocument })
  });
  const save = update.mutate;

  const declared = useMemo(() => new Map<string, DeviceStream>((devices.data ?? []).flatMap((device) =>
    device.streams.map((stream): [string, DeviceStream] => [`${device.hardwareId}__${stream.id}`, stream]))),
  [devices.data]);
  const channels = useMemo(() => monitorChannels(monitor), [monitor]);
  const infos = useMemo(() => {
    const recorded = new Map((timeline?.streams ?? []).map((stream) => [stream.key, stream]));
    return new Map(channels.map((ref): [string, StreamInfo] => {
      const key = streamKey(ref);
      const info = declaredStreamInfo(ref.hardwareId, declared.get(key), ref.streamId);
      const run = recorded.get(key);
      if (!run) return [key, info];
      const merged: StreamInfo = { ...info, ...run };
      if (!run.declaration && info.declaration) merged.declaration = info.declaration;
      return [key, merged];
    }));
  }, [channels, declared, timeline?.streams]);
  /** The streams a panel shows, in its order, that its type can draw. */
  const streamsOf = useCallback((panel: MonitorPanel): StreamInfo[] => panel.sources.flatMap((ref) => {
    const info = infos.get(streamKey(ref));
    return info && panelDraws(panel.type, String(info.type)) ? [info] : [];
  }), [infos]);
  const typeOf = useCallback((ref: StreamRef) => declared.get(streamKey(ref))?.type, [declared]);

  const addTo = useCallback((panelId: string, ref: StreamRef) =>
    save({ operations: [{ op: "addSources", panelId, sources: [ref] }] }), [save]);
  /**
   * Puts a stream on the panel last focused when it draws the stream, else on the first panel that
   * does; never creates a panel. Returns the panel's title, or undefined when none can show it.
   */
  const place = useCallback((ref: StreamRef): string | undefined => {
    const type = declared.get(streamKey(ref))?.type;
    const focused = monitor.panels.find((panel) => panel.id === focusedPanelId);
    const target = focused && panelDraws(focused.type, type) ? focused
      : monitor.panels.find((panel) => panelDraws(panel.type, type));
    if (!target) return undefined;
    addTo(target.id, ref);
    return panelTitle(target);
  }, [declared, monitor.panels, addTo]);
  const removeFrom = useCallback((panelId: string, ref: StreamRef) =>
    save({ operations: [{ op: "removeSources", panelId, sources: [ref] }] }), [save]);
  const addPanel = useCallback((type: PanelType, sources: StreamRef[] = [], placement?: Placement) =>
    save({ operations: [{ op: "addPanel", panel: { type, sources }, ...(placement ? { placement } : {}) }] }), [save]);
  const removePanel = useCallback((panelId: string) =>
    save({ operations: [{ op: "removePanel", panelId }] }), [save]);
  const saveLayout = useCallback((layout: Record<string, unknown>) => save({ layout }), [save]);
  const updatePanel = useCallback((panelId: string, change: { title?: string; settings?: Record<string, unknown> }) =>
    save({ operations: [{ op: "updatePanel", panelId, ...change }] }), [save]);
  const addControl = useCallback((panelId: string, control: Omit<MonitorControl, "id">) =>
    save({ operations: [{ op: "addControl", panelId, control }] }), [save]);
  const removeControl = useCallback((panelId: string, controlId: string) =>
    save({ operations: [{ op: "removeControl", panelId, controlId }] }), [save]);
  /** Puts a panel's streams in this order (and only these). */
  const setSources = useCallback((panelId: string, sources: StreamRef[]) => {
    const current = monitor.panels.find((panel) => panel.id === panelId)?.sources ?? [];
    save({ operations: [
      ...(current.length ? [{ op: "removeSources" as const, panelId, sources: current }] : []),
      ...(sources.length ? [{ op: "addSources" as const, panelId, sources }] : [])
    ] });
  }, [monitor.panels, save]);
  /** Replaces the whole workspace (a preset, an imported file, a generated layout). */
  const replace = useCallback((next: Pick<Monitor, "panels" | "layout">) => save({
    panels: next.panels.map(({ id, type, title, sources, settings, placement }) => ({
      id, type, sources, settings, ...(title !== undefined ? { title } : {}), ...(placement ? { placement } : {})
    })),
    layout: next.layout
  }), [save]);

  return {
    projectId: project.data?.file.projectId,
    monitor,
    channels,
    streams: [...infos.values()],
    streamsOf,
    typeOf,
    place,
    addTo,
    removeFrom,
    addPanel,
    removePanel,
    saveLayout,
    updatePanel,
    addControl,
    removeControl,
    replace,
    setSources,
    devices: devices.data ?? [],
    declarationOf: (ref: StreamRef) => declared.get(streamKey(ref)),
    error: update.error
  };
}

export type MonitorWorkspace = ReturnType<typeof useMonitorWorkspace>;
