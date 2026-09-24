import type { ProjectFolderSelection } from "@hardwareharness/contracts/projects";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter } from "../ui";

export function InitializeDialog({ selection, busy, onConfirm, onCancel }: {
  selection: ProjectFolderSelection | undefined;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={Boolean(selection)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent title="初始化 HardwareHarness 项目" size="sm">
        <DialogBody className="grid gap-2">
          <p>
            文件夹 <strong className="text-fg">{selection?.name}</strong> 中还没有{" "}
            <code className="font-mono text-xs text-signal">.hardwareharness/project.json</code>。
          </p>
          <p className="text-xs text-fg-3">继续只会创建项目清单，不会修改其他文件。</p>
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={onCancel}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm}>创建并打开</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
