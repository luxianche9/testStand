import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Hardware } from "@hardwareharness/contracts/devices";
import type { IcdCheck, ProtocolBinding } from "@hardwareharness/contracts/testing";
import { PencilIcon, XIcon } from "lucide-react";
import {
  Badge, Button, cn, Dialog, DialogBody, DialogContent, DialogFooter, Field, IconButton, Input, Select, Textarea
} from "../../ui";
import { useToast } from "../../ui/toast.js";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import {
  bindingIssues, icdTemplate, nextAlias, parseSamples, sampleIssue, trialRows
} from "./protocol-bindings.js";

/** Streams an ICD can decode (design §6.4); others are listed only when already bound. */
const rawTypes = new Set(["bytes", "frames"]);

type Editing = { name?: string; alias?: string };

/**
 * 协议绑定 (design §6.4, U5): which ICD decodes which raw device stream, and under which alias
 * the plan's steps name the derived streams. ICD files are edited and trial-decoded in place.
 */
export function ProtocolBindingsEditor({ value, hardware, onChange }: {
  value: ProtocolBinding[];
  hardware: Hardware[];
  onChange: (value: ProtocolBinding[]) => void;
}) {
  const icds = useQuery({ queryKey: queryKeys.icds, queryFn: () => window.hardwareharness.testing.listIcds() });
  const [editing, setEditing] = useState<Editing>();
  const issues = bindingIssues(value);
  const set = (index: number, patch: Partial<ProtocolBinding>) =>
    onChange(value.map((binding, at) => (at === index ? { ...binding, ...patch } : binding)));
  const add = () => {
    const icd = icds.data?.find((item) => item.valid)?.name ?? "";
    onChange([...value, { icd, alias: nextAlias(value, icd), source: { hardwareId: "", streamId: "" } }]);
  };

  return (
    <div className="grid gap-2">
      {value.map((binding, index) => (
        <BindingRow
          key={index}
          binding={binding}
          hardware={hardware}
          icds={icds.data ?? []}
          issue={issues[index]}
          onChange={(patch) => set(index, patch)}
          onRemove={() => onChange(value.filter((_, at) => at !== index))}
          onEdit={() => setEditing({ name: binding.icd, alias: binding.alias })}
        />
      ))}
      {icds.error && <span className="text-xs text-fail">读取 ICD 列表失败：{errorMessage(icds.error)}</span>}
      <div className="flex gap-2">
        <Button size="xs" onClick={add}>添加绑定</Button>
        <Button size="xs" variant="ghost" onClick={() => setEditing({})}>新建 ICD</Button>
      </div>
      {editing && (
        <IcdEditorDialog
          {...editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

function BindingRow({ binding, hardware, icds, issue, onChange, onRemove, onEdit }: {
  binding: ProtocolBinding;
  hardware: Hardware[];
  icds: Array<{ name: string; valid: boolean; error?: string }>;
  issue: string | undefined;
  onChange: (patch: Partial<ProtocolBinding>) => void;
  onRemove: () => void;
  onEdit: () => void;
}) {
  const { hardwareId, streamId } = binding.source;
  const streams = useQuery({
    queryKey: queryKeys.deviceStreams(hardwareId),
    queryFn: () => window.hardwareharness.streams.listStreams({ hardwareId }),
    enabled: Boolean(hardwareId)
  });
  const choices = (streams.data ?? []).filter((stream) => rawTypes.has(String(stream.type)) || stream.id === streamId);
  const known = icds.find((item) => item.name === binding.icd);
  return (
    <div
      role="group"
      aria-label={`协议绑定 ${binding.alias}`}
      className="grid gap-1.5 rounded-sm border border-line bg-surface-0 p-2"
    >
      <div className="flex items-center gap-1.5">
        <Input
          aria-label="别名"
          className="w-28 font-mono"
          value={binding.alias}
          onChange={(event) => onChange({ alias: event.target.value })}
        />
        <Select
          aria-label="ICD"
          className="min-w-0 flex-1"
          value={binding.icd}
          onChange={(event) => onChange({ icd: event.target.value })}
        >
          <option value="">选择 ICD</option>
          {!known && binding.icd && <option value={binding.icd}>{binding.icd}（不存在）</option>}
          {icds.map((item) => (
            <option key={item.name} value={item.name}>{item.valid ? item.name : `${item.name}（无效）`}</option>
          ))}
        </Select>
        <IconButton label="编辑 ICD" size="icon-sm" disabled={!known} onClick={onEdit}><PencilIcon /></IconButton>
        <IconButton label="删除绑定" size="icon-sm" onClick={onRemove}><XIcon /></IconButton>
      </div>
      <div className="flex items-center gap-1.5">
        <Select
          aria-label="源设备"
          className="min-w-0 flex-1"
          value={hardwareId}
          onChange={(event) => onChange({ source: { hardwareId: event.target.value, streamId: "" } })}
        >
          <option value="">选择设备</option>
          {hardware.filter((item) => item.kind === "managed").map((item) => (
            <option key={item.hardwareId} value={item.hardwareId}>{item.label} · {item.hardwareId}</option>
          ))}
        </Select>
        <Select
          aria-label="原始数据流"
          className="min-w-0 flex-1"
          value={streamId}
          disabled={!hardwareId}
          onChange={(event) => onChange({ source: { hardwareId, streamId: event.target.value } })}
        >
          <option value="">选择数据流</option>
          {streamId && !choices.some((stream) => stream.id === streamId) && (
            <option value={streamId}>{streamId}</option>
          )}
          {choices.map((stream) => (
            <option key={stream.id} value={stream.id}>{stream.id} · {String(stream.type)}</option>
          ))}
        </Select>
      </div>
      {(issue || (known && !known.valid)) && (
        <span className="text-xs text-fail">{issue ?? `ICD 无效：${known?.error ?? ""}`}</span>
      )}
    </div>
  );
}

/** Edit an ICD file's YAML, check it and trial-decode sample bytes before saving. */
export function IcdEditorDialog({ name, alias, onClose }: Editing & { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const creating = !name;
  const document = useQuery({
    queryKey: queryKeys.icd(name ?? ""),
    queryFn: () => window.hardwareharness.testing.readIcd({ name: name ?? "" }),
    enabled: !creating
  });
  const [fileName, setFileName] = useState(name ?? "");
  const [text, setText] = useState(creating ? icdTemplate("") : "");
  const [samplesText, setSamplesText] = useState("");
  const [check, setCheck] = useState<IcdCheck>();
  useEffect(() => { if (document.data) setText(document.data.text); }, [document.data]);

  const samples = parseSamples(samplesText);
  const badSample = sampleIssue(samples);
  const run = useMutation({
    mutationFn: () => window.hardwareharness.testing.checkIcd({
      input: { text, ...(alias ? { alias } : {}), ...(samples.length ? { samples } : {}) }
    }),
    onSuccess: setCheck,
    onError: (error) => toast.error(errorMessage(error))
  });
  const save = useMutation({
    mutationFn: () => window.hardwareharness.testing.saveIcd({ input: { name: fileName.trim(), text } }),
    onSuccess: async (result) => {
      toast.success(`已保存 ICD ${result.name}`);
      await client.invalidateQueries({ queryKey: queryKeys.icds });
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error))
  });
  const rows = trialRows(check?.decoded);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent title={creating ? "新建 ICD" : `编辑 ICD ${name}`} size="xl">
        <DialogBody className="grid gap-3">
          {creating && (
            <Field label="文件名" required hint="保存为项目 icd 目录下的 <文件名>.icd.yaml">
              <Input value={fileName} onChange={(event) => setFileName(event.target.value)} />
            </Field>
          )}
          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-3">
            <Field label="ICD（YAML）">
              <Textarea
                aria-label="ICD 内容"
                className="h-80 font-mono text-xs"
                spellCheck={false}
                value={text}
                onChange={(event) => { setText(event.target.value); setCheck(undefined); }}
              />
            </Field>
            <div className="grid content-start gap-3">
              <Field label="试解码样本" hint="每行一段十六进制字节，按到达顺序拼接；# 之后为注释。" error={badSample}>
                <Textarea
                  aria-label="试解码样本"
                  className="h-28 font-mono text-xs"
                  spellCheck={false}
                  value={samplesText}
                  onChange={(event) => setSamplesText(event.target.value)}
                />
              </Field>
              <IcdCheckResult check={check} rows={rows} />
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button disabled={!text.trim() || Boolean(badSample) || run.isPending} onClick={() => run.mutate()}>
            检查并试解码
          </Button>
          <Button
            variant="primary"
            disabled={!fileName.trim() || !text.trim() || save.isPending || check?.valid === false}
            onClick={() => save.mutate()}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IcdCheckResult({ check, rows }: { check: IcdCheck | undefined; rows: ReturnType<typeof trialRows> }) {
  if (!check) return <p className="text-xs text-fg-3">修改后点「检查并试解码」查看解析结果。</p>;
  if (!check.valid) {
    return (
      <section aria-label="检查结果" className="grid gap-1 text-xs text-fail">
        <strong>ICD 无效：{check.error}</strong>
        {(check.issues ?? []).map((issue, index) => (
          <span key={index} className="font-mono">{issue.path || "/"}：{issue.message}</span>
        ))}
      </section>
    );
  }
  const icd = check.icd;
  return (
    <section aria-label="检查结果" className="grid gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="pass">有效</Badge>
        <span className="text-fg-2">
          {icd?.transport} · {icd?.messages.length ?? 0} 个报文 · {icd?.encoders.length ?? 0} 个编码器
        </span>
      </div>
      {icd && (
        <div className="max-h-24 overflow-auto font-mono text-2xs text-fg-3">
          {icd.streams.map((stream) => (
            <div key={stream.streamId}>{stream.streamId} · {stream.type}{stream.unit ? ` · ${stream.unit}` : ""}</div>
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <div aria-label="试解码结果" role="list" className="max-h-40 overflow-auto rounded-sm border border-line">
          {rows.map((row, index) => (
            <div
              role="listitem"
              key={index}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2 border-b border-line px-2 py-0.5",
                "font-mono text-2xs"
              )}
            >
              <span className="truncate text-fg-3">{row.streamId}</span>
              <span className={cn("truncate", row.failed ? "text-fail" : "text-fg")} title={row.text}>{row.text}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
