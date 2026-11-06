import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IcdCheck } from "@teststand/contracts/testing";
import { Badge, Button, cn, Dialog, DialogBody, DialogContent, DialogFooter, Field, Textarea } from "../../ui";
import { useToast } from "../../ui/toast.js";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import { icdTemplate, parseSamples, sampleIssue, trialRows } from "./icd-model.js";

type Editing = { name?: string; alias?: string };

/** The `name:` a YAML ICD declares at its top level, when it is a valid name. */
function declaredName(text: string): string | undefined {
  return /^name:\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*(?:#.*)?$/m.exec(text)?.[1];
}

/** Edit an ICD file's YAML, check it and trial-decode sample bytes before saving. */
export function IcdEditorDialog({ name, alias, onClose, onSaved }: Editing & {
  onClose: () => void;
  /** Called with the saved ICD's name, e.g. to select an ICD just created. */
  onSaved?: (name: string) => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const creating = !name;
  const document = useQuery({
    queryKey: queryKeys.icd(name ?? ""),
    queryFn: () => window.teststand.testing.readIcd({ name: name ?? "" }),
    enabled: !creating
  });
  const [text, setText] = useState(creating ? icdTemplate("") : "");
  const [samplesText, setSamplesText] = useState("");
  const [check, setCheck] = useState<IcdCheck>();
  useEffect(() => { if (document.data) setText(document.data.text); }, [document.data]);

  // The file is named after the ICD's own `name` (the backend requires them to match).
  const fileName = creating ? declaredName(text) ?? "" : name;
  const samples = parseSamples(samplesText);
  const badSample = sampleIssue(samples);
  const run = useMutation({
    mutationFn: () => window.teststand.testing.checkIcd({
      input: { text, ...(alias ? { alias } : {}), ...(samples.length ? { samples } : {}) }
    }),
    onSuccess: setCheck,
    onError: (error) => toast.error(errorMessage(error))
  });
  const save = useMutation({
    mutationFn: () => window.teststand.testing.saveIcd({ input: { name: fileName, text } }),
    onSuccess: async (result) => {
      toast.success(`已保存 ICD ${result.name}`);
      await client.invalidateQueries({ queryKey: queryKeys.icds });
      // Bound ICDs decide which protocol fields the devices offer.
      await client.invalidateQueries({ queryKey: queryKeys.protocols });
      await client.invalidateQueries({ queryKey: queryKeys.monitorStreams });
      onSaved?.(result.name);
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error))
  });
  const units = new Map((check?.icd?.streams ?? []).flatMap((stream) =>
    stream.unit ? [[stream.streamId, stream.unit] as const] : []));
  const rows = trialRows(check?.decoded, units);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent title={creating ? "新建 ICD" : `编辑 ICD ${name}`} size="xl">
        <DialogBody className="grid gap-3">
          {creating && (
            <p className={cn("text-xs", fileName ? "text-fg-2" : "text-fail")}>
              {fileName ? <>保存为项目的 <code className="font-mono">icd/{fileName}.icd.yaml</code>（文件名取 ICD 的 name）</>
                : "在 YAML 里写上 name（字母、数字、下划线，不以数字开头），文件以它命名"}
            </p>
          )}
          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-3">
            <Field label="ICD（YAML）" className="content-start">
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
            disabled={!fileName || !text.trim() || save.isPending || check?.valid === false}
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
        <div aria-label="试解码结果" role="list" className="max-h-56 overflow-auto rounded-sm border border-line">
          {rows.map((row, index) => (
            <div
              role="listitem"
              key={index}
              title={row.raw ? row.raw.toUpperCase().replace(/(..)(?=.)/g, "$1 ") : undefined}
              className={cn(
                "grid grid-cols-[2.25rem_6.5rem_minmax(0,1fr)] gap-2 border-b border-line px-2 py-0.5",
                "font-mono text-2xs"
              )}
            >
              <span className="text-fg-3">{row.sample === undefined ? "" : `#${row.sample}`}</span>
              <span className={cn("truncate", row.failed ? "text-fail" : "text-fg-2")}>{row.label}</span>
              <span className={cn("truncate", row.failed ? "text-fail" : "text-fg")}>{row.text}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
