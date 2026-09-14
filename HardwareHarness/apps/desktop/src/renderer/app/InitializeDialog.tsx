import type { ProjectFolderSelection } from "@hardwareharness/contracts/projects";
import { Button } from "../shared/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../shared/ui/dialog";

export function InitializeDialog({ selection, busy, onConfirm, onCancel }: {
  selection: ProjectFolderSelection | undefined;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={Boolean(selection)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent size="sm">
        <DialogHeader title="初始化 HardwareHarness 项目" />
        <DialogBody>
          <p className="m-0 text-sm">文件夹 <strong>{selection?.name}</strong> 中还没有 <code>.hardwareharness/project.json</code>。</p>
          <p className="mt-2 mb-0 text-xs text-muted-foreground">继续只会创建项目清单，不会修改其他文件。</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>取消</Button>
          <Button disabled={busy} onClick={onConfirm}>创建并打开</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
