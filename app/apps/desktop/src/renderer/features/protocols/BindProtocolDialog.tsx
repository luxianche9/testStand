import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PencilIcon, PlusIcon } from "lucide-react";
import {
  Button, Dialog, DialogBody, DialogContent, DialogFooter, Field, IconButton, Input, Select
} from "../../ui/index.js";
import { useToast } from "../../ui/toast.js";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import { ALIAS, nextAlias } from "./icd-model.js";
import { IcdEditorDialog } from "./IcdEditorDialog.js";
import { useUpdateProtocols } from "./use-protocols.js";

/**
 * 解析协议: put an ICD on one raw stream. The ICD says how the bytes split into frames and fields; once
 * bound, each numeric field is a stream of the same device, `<alias>.<message>.<field>`, with a live value.
 */
export function BindProtocolDialog({ hardwareId, streamId, streamType, aliases, onClose }: {
  hardwareId: string;
  streamId: string;
  /** `bytes` or `frames`: only ICDs of that transport can decode it. */
  streamType: string;
  /** Aliases already bound in the project. */
  aliases: readonly string[];
  onClose: () => void;
}) {
  const toast = useToast();
  const icds = useQuery({ queryKey: queryKeys.icds, queryFn: () => window.teststand.testing.listIcds() });
  const usable = (icds.data ?? []).filter((item) => item.valid && (!item.transport || item.transport === streamType));
  const [icd, setIcd] = useState<string>();
  const [alias, setAlias] = useState<string>();
  const [editing, setEditing] = useState<{ name?: string }>();
  const update = useUpdateProtocols();
  const chosen = icd ?? usable[0]?.name ?? "";
  const name = alias ?? nextAlias(aliases, chosen);
  const aliasError = !ALIAS.test(name) ? "别名只能包含字母、数字和下划线，且不能以数字开头"
    : aliases.includes(name) ? `别名 ${name} 已被使用` : undefined;

  const bind = () => update.mutate(
    [{ op: "add", icd: chosen, alias: name, source: { hardwareId, streamId } }],
    {
      onSuccess: () => { toast.success(`已用 ${chosen} 解析 ${streamId}`); onClose(); },
      onError: (error) => toast.error(errorMessage(error))
    }
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent title={`解析协议：${hardwareId} / ${streamId}`} size="md">
        <DialogBody className="grid gap-3">
          <p className="text-xs text-fg-2">
            选一份协议（ICD），它规定这条{streamType === "frames" ? "报文" : "字节"}流怎么切成帧、每个字段在哪几个字节。
            绑定后每个数值字段都是一个变量，带实时值，可以拖到面板上，测试步骤也能直接引用。
          </p>
          <Field label="协议（ICD）" error={icds.error ? errorMessage(icds.error) : undefined}
            hint={usable.length ? undefined : `项目里还没有能解码 ${streamType} 流的 ICD，先新建一份`}>
            <div className="flex items-center gap-1.5">
              <Select aria-label="ICD" className="min-w-0 flex-1" value={chosen}
                onChange={(event) => setIcd(event.target.value)}>
                {!usable.length && <option value="">（无）</option>}
                {usable.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}{item.description ? ` · ${item.description}` : ""}
                  </option>
                ))}
              </Select>
              <IconButton label="编辑这份 ICD" size="icon-sm" disabled={!chosen}
                onClick={() => setEditing({ name: chosen })}><PencilIcon /></IconButton>
              <Button size="sm" onClick={() => setEditing({})}><PlusIcon />新建 ICD</Button>
            </div>
          </Field>
          <Field label="别名" error={aliasError}
            hint={`字段变量命名为「${name || "别名"}.报文.字段」，在整个项目里唯一。`}>
            <Input aria-label="别名" className="font-mono" value={name}
              onChange={(event) => setAlias(event.target.value)} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!chosen || Boolean(aliasError) || update.isPending} onClick={bind}>
            绑定
          </Button>
        </DialogFooter>
      </DialogContent>
      {editing && (
        <IcdEditorDialog
          {...editing}
          alias={name}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => setIcd(saved)}
        />
      )}
    </Dialog>
  );
}
