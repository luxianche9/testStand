import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IcdCheck } from "@teststand/contracts/testing";
import { DownloadIcon, WandSparklesIcon } from "lucide-react";
import {
  Badge, Button, cn, Dialog, DialogBody, DialogContent, DialogFooter, Field, Input, SegmentedControl, Textarea
} from "../../ui";
import { useToast } from "../../ui/toast.js";
import { errorMessage } from "../../lib/errors.js";
import { queryKeys } from "../../lib/query-keys.js";
import { ByteInspector } from "./ByteInspector.js";
import { guessHeader, hexBytes, newIcdDoc, type IcdDoc } from "./icd-document.js";
import { icdTemplate, parseSamples, sampleIssue, trialRows } from "./icd-model.js";
import { ChecksumSection, EncodersSection, FramingSection, MessagesSection } from "./IcdTables.js";

type Mode = "table" | "yaml";
type Editing = { name?: string; alias?: string };

const modeOptions = [
  { value: "table", label: "表格", title: "按帧格式、报文、字段逐项填写" },
  { value: "yaml", label: "YAML", title: "直接编辑 ICD 文件（高级）" }
] as const;

/** The `name:` a YAML ICD declares at its top level, when it is a valid name. */
function declaredName(text: string): string | undefined {
  return /^name:\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*(?:#.*)?$/m.exec(text)?.[1];
}

/**
 * The protocol (ICD) editor. 表格 edits it field by field; YAML edits the file itself. Sample bytes — pasted,
 * or the stream's last bytes when it was opened for one — are decoded as they would be live; pick a frame to
 * see it byte by byte and turn bytes into fields.
 */
export function IcdEditorDialog({ name, alias, source, onClose, onSaved }: Editing & {
  /** The raw stream it is written for: its recent bytes can be taken as samples. */
  source?: { hardwareId: string; streamId: string } | undefined;
  onClose: () => void;
  /** Called with the saved ICD's name, e.g. to select an ICD just created. */
  onSaved?: (name: string) => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const creating = !name;
  const opened = useQuery({
    queryKey: ["icd-editor", name ?? ""],
    queryFn: async () => {
      if (!name) return { text: icdTemplate(""), document: undefined, algorithms: undefined };
      const [file, parsed] = await Promise.all([
        window.teststand.testing.readIcd({ name }),
        window.teststand.testing.icdDocument({ input: { name } })
      ]);
      return { text: file.text, document: parsed.valid ? parsed.document : undefined, algorithms: parsed.algorithms };
    },
    staleTime: Infinity,
    gcTime: 0
  });
  const [mode, setMode] = useState<Mode>("table");
  const [doc, setDoc] = useState<IcdDoc>(() => newIcdDoc(""));
  const [text, setText] = useState("");
  const [algorithms, setAlgorithms] = useState<readonly string[]>(["sum8", "xor8", "crc8", "crc16_modbus"]);
  const [message, setMessage] = useState(0);
  const [highlight, setHighlight] = useState<string>();
  const [samplesText, setSamplesText] = useState("");
  const [row, setRow] = useState<number>();
  const [check, setCheck] = useState<IcdCheck>();
  useEffect(() => {
    const data = opened.data;
    if (!data) return;
    setText(data.text);
    if (data.algorithms) setAlgorithms(data.algorithms);
    if (data.document) setDoc(data.document as unknown as IcdDoc);
    // A file the table cannot show (broken YAML, invalid ICD) opens as text.
    setMode(name && !data.document ? "yaml" : "table");
  }, [opened.data, name]);

  const samples = useMemo(() => parseSamples(samplesText), [samplesText]);
  const badSample = sampleIssue(samples);
  const input = mode === "table" ? { document: doc } : { text };
  const run = useMutation({
    mutationFn: () => window.teststand.testing.checkIcd({
      input: { ...input, ...(alias ? { alias } : {}), ...(samples.length && !badSample ? { samples } : {}) }
    }),
    onSuccess: setCheck
  });
  // Decode again shortly after every change, so a field defined from bytes shows its value at once.
  const signature = JSON.stringify([mode, mode === "table" ? doc : text, samples]);
  useEffect(() => {
    if (!opened.data) return undefined;
    const timer = window.setTimeout(() => run.mutate(), 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` stands for everything checked
  }, [signature, opened.data]);

  const switchMode = async (next: Mode) => {
    if (next === mode) return;
    try {
      if (next === "yaml") {
        const rendered = await window.teststand.testing.renderIcd({ input: { document: doc } });
        if (!rendered.valid || rendered.text === undefined) throw new Error(rendered.error ?? "表格里有错误");
        setText(rendered.text);
      } else {
        const parsed = await window.teststand.testing.icdDocument({ input: { text } });
        if (!parsed.valid || !parsed.document) throw new Error(parsed.error ?? "YAML 无效");
        setDoc(parsed.document as unknown as IcdDoc);
        setMessage(0);
      }
      setMode(next);
    } catch (error) {
      toast.error(`先改正再切换：${errorMessage(error)}`);
    }
  };

  const fileName = mode === "table" ? doc.name : creating ? declaredName(text) ?? "" : name;
  const save = useMutation({
    mutationFn: () => window.teststand.testing.saveIcd({
      input: mode === "table" ? { name: fileName ?? "", document: doc } : { name: fileName ?? "", text }
    }),
    onSuccess: async (result) => {
      toast.success(`已保存协议 ${result.name}`);
      await client.invalidateQueries({ queryKey: queryKeys.icds });
      // Bound ICDs decide which protocol fields the devices offer.
      await client.invalidateQueries({ queryKey: queryKeys.protocols });
      await client.invalidateQueries({ queryKey: queryKeys.monitorStreams });
      onSaved?.(result.name);
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error))
  });
  const capture = useMutation({
    mutationFn: () => window.teststand.streams.recent({
      key: `${source?.hardwareId ?? ""}__${source?.streamId ?? ""}`, limit: 200
    }),
    onSuccess: (recent) => {
      const lines = recent.records.filter((record) => record.dir === "rx" && record.data).map((record) =>
        String(record.data).toUpperCase().replace(/(..)(?!$)/g, "$1 "));
      if (!lines.length) toast.error("最近没有收到数据：确认设备在发送，链路已连接");
      setSamplesText(lines.join("\n"));
      setRow(undefined);
    },
    onError: (error) => toast.error(errorMessage(error))
  });

  const units = new Map((check?.icd?.streams ?? []).flatMap((stream) =>
    stream.unit ? [[stream.streamId, stream.unit] as const] : []));
  const rows = trialRows(check?.decoded, units);
  const picked = row !== undefined ? rows[row] : undefined;
  const pickedBytes = picked ? hexBytes(picked.raw) ?? [] : [];
  const matched = picked && !picked.failed ? doc.messages.findIndex((item) => item.name === picked.label) : -1;
  const header = mode === "table" && doc.transport === "bytes" ? guessHeader(samples) : undefined;
  const headerDiffers = header && doc.framing && "header" in doc.framing
    && (doc.framing.header ?? "").replace(/\s/g, "").toUpperCase() !== header.replace(/\s/g, "");

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent title={creating ? "新建协议（ICD）" : `编辑协议 ${name}`} size="xl"
        className="w-[min(1360px,calc(100vw-80px))]"
        actions={<SegmentedControl<Mode> label="编辑方式" size="xs" value={mode} options={modeOptions}
          onChange={(next) => void switchMode(next)} />}>
        <DialogBody className="grid h-[70vh] min-h-0 grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-3">
          <div className="grid min-h-0 content-start gap-2 overflow-x-hidden overflow-y-auto pr-1">
            {opened.error && <p className="text-xs text-fail">读取失败：{errorMessage(opened.error)}</p>}
            {mode === "table" ? (
              <>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="协议名" className="w-44"
                    hint={creating
                      ? <>保存为 <code className="font-mono">icd/{doc.name || "…"}.icd.yaml</code></> : undefined}>
                    <Input aria-label="协议名" className="font-mono" value={doc.name} disabled={!creating}
                      onChange={(event) => setDoc({ ...doc, name: event.target.value })} />
                  </Field>
                  <Field label="说明" className="min-w-0 flex-1">
                    <Input aria-label="协议说明" value={doc.description ?? ""}
                      onChange={(event) => setDoc({ ...doc, description: event.target.value || null })} />
                  </Field>
                  <Field label="数据形式" className="shrink-0">
                    <SegmentedControl<"bytes" | "frames"> label="数据形式" size="xs" value={doc.transport}
                      options={[{ value: "bytes", label: "字节流" }, { value: "frames", label: "报文流" }]}
                      onChange={(transport) => setDoc({
                        ...doc, transport,
                        framing: transport === "frames" ? null : doc.framing ?? newIcdDoc("").framing ?? null
                      })} />
                  </Field>
                </div>
                <FramingSection doc={doc} onChange={setDoc} />
                <ChecksumSection doc={doc} algorithms={algorithms} onChange={setDoc} />
                <MessagesSection doc={doc} selected={Math.min(message, Math.max(0, doc.messages.length - 1))}
                  highlight={highlight} onSelect={setMessage} onChange={setDoc} />
                <EncodersSection doc={doc} onChange={setDoc} />
              </>
            ) : (
              <>
                {creating && (
                  <p className={cn("text-xs", fileName ? "text-fg-2" : "text-fail")}>
                    {fileName ? <>保存为项目的 <code className="font-mono">icd/{fileName}.icd.yaml</code>（文件名取 ICD 的 name）</>
                      : "在 YAML 里写上 name（字母、数字、下划线，不以数字开头），文件以它命名"}
                  </p>
                )}
                <Textarea aria-label="ICD 内容" className="h-[62vh] font-mono text-xs" spellCheck={false} value={text}
                  onChange={(event) => setText(event.target.value)} />
              </>
            )}
          </div>
          <div className="grid min-h-0 content-start gap-2 overflow-y-auto">
            <Field label="样本报文" error={badSample}
              hint="每行一段十六进制字节，按到达顺序拼接后切帧；# 之后为注释。">
              <Textarea aria-label="试解码样本" className="h-28 font-mono text-xs" spellCheck={false}
                value={samplesText} onChange={(event) => { setSamplesText(event.target.value); setRow(undefined); }} />
            </Field>
            <div className="flex flex-wrap items-center gap-1.5">
              {source && (
                <Button size="xs" disabled={capture.isPending} onClick={() => capture.mutate()}
                  title={`取 ${source.hardwareId}/${source.streamId} 最近收到的字节`}>
                  <DownloadIcon />抓取最近报文
                </Button>
              )}
              <Button size="xs" disabled={Boolean(badSample) || run.isPending} onClick={() => run.mutate()}>
                检查并试解码
              </Button>
              {headerDiffers && header && (
                <Button size="xs" variant="ghost" title="每段样本都以这几个字节开头"
                  onClick={() => doc.framing && setDoc({ ...doc, framing: { ...doc.framing, header } })}>
                  <WandSparklesIcon />帧头可能是 {header}
                </Button>
              )}
            </div>
            <IcdCheckResult check={check} rows={rows} selected={row} onSelect={setRow} />
            {picked && mode === "table" && pickedBytes.length > 0 && (
              <ByteInspector bytes={pickedBytes} label={picked.label} doc={doc}
                matched={matched >= 0 ? matched : undefined}
                onChange={(next, index, field) => { setDoc(next); setMessage(index); setHighlight(field); }} />
            )}
            {picked && mode === "yaml" && (
              <p className="text-2xs text-fg-3">切到「表格」可以逐字节查看这一帧并定义字段。</p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!fileName || save.isPending || check?.valid === false}
            onClick={() => save.mutate()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IcdCheckResult({ check, rows, selected, onSelect }: {
  check: IcdCheck | undefined;
  rows: ReturnType<typeof trialRows>;
  selected: number | undefined;
  onSelect: (row: number) => void;
}) {
  if (!check) return <p className="text-xs text-fg-3">正在检查…</p>;
  if (!check.valid) {
    return (
      <section aria-label="检查结果" className="grid gap-1 text-xs text-fail">
        <strong>协议有误：{check.error}</strong>
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
          {icd?.transport === "frames" ? "报文流" : "字节流"} · {icd?.messages.length ?? 0} 种报文 ·{" "}
          {icd?.encoders.length ?? 0} 个编码器
        </span>
      </div>
      {rows.length > 0 ? (
        <div aria-label="试解码结果" role="list" className="max-h-56 overflow-auto rounded-sm border border-line">
          {rows.map((row, index) => (
            <button
              type="button"
              role="listitem"
              key={index}
              aria-current={index === selected || undefined}
              title={row.raw ? `${row.raw.toUpperCase().replace(/(..)(?=.)/g, "$1 ")}（点开逐字节查看）` : undefined}
              onClick={() => onSelect(index)}
              className={cn(
                "grid w-full grid-cols-[2.25rem_6.5rem_minmax(0,1fr)] gap-2 border-b border-line px-2 py-0.5 text-left",
                "font-mono text-2xs hover:bg-surface-2", index === selected && "bg-signal/10"
              )}
            >
              <span className="text-fg-3">{row.sample === undefined ? "" : `#${row.sample}`}</span>
              <span className={cn("truncate", row.failed ? "text-fail" : "text-fg-2")}>{row.label}</span>
              <span className={cn("truncate", row.failed ? "text-fail" : "text-fg")}>{row.text}</span>
            </button>
          ))}
        </div>
      ) : <p className="text-2xs text-fg-3">贴入样本字节或抓取最近报文，看它解出什么。</p>}
    </section>
  );
}
