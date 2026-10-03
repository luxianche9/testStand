import { PlusIcon } from "lucide-react";
import { Button, SegmentedControl, Toolbar, ToolbarDivider } from "../../ui/index.js";

export type WiringView = "canvas" | "list";

const viewOptions = [
  { value: "canvas", label: "画布", title: "在画布上摆放设备并拖线" },
  { value: "list", label: "列表", title: "按端口列出所有接线" }
] as const;

/** Bench command bar: view switch, live counts, and the one entry point for creating a cable by
 *  picking both ends (also reachable through the `wiring.new-connection` command). */
export function WiringToolbar({ view, onViewChange, nodeCount, connectionCount, saving, onCreate }: {
  view: WiringView;
  onViewChange: (view: WiringView) => void;
  nodeCount: number;
  connectionCount: number;
  saving: boolean;
  onCreate: () => void;
}) {
  return (
    <Toolbar aria-label="接线工具栏">
      <SegmentedControl<WiringView> label="接线视图" value={view} options={viewOptions} onChange={onViewChange} />
      <ToolbarDivider />
      <span className="tf-label text-fg-3">节点</span>
      <span className="tf-num text-xs text-fg">{nodeCount}</span>
      <span className="tf-label ml-2 text-fg-3">接线</span>
      <span className="tf-num text-xs text-fg">{connectionCount}</span>
      {saving && <span className="ml-2 text-2xs text-fg-3">正在保存…</span>}
      <Button variant="primary" size="xs" className="ml-auto" onClick={onCreate}>
        <PlusIcon />新建接线
      </Button>
    </Toolbar>
  );
}
