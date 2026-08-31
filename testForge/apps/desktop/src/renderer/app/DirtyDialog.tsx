import type { PendingAction } from "../shared/hooks/useDirtyGuard.js";
import { Button } from "../shared/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "../shared/ui/dialog";

export function DirtyDialog({ pending, onContinue, onCancel }: {
  pending: PendingAction | undefined;
  onContinue: (saveFirst: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={Boolean(pending)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent size="sm">
        <DialogHeader title="保存项目修改" />
        <DialogBody>
          <p className="m-0 text-sm">当前项目有未保存的修改。要在{pending?.label}前保存吗？</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button variant="destructive" onClick={() => onContinue(false)}>放弃修改</Button>
          <Button onClick={() => onContinue(true)}>保存并继续</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
