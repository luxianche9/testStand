import { useState } from "react";
import { SendIcon, StarIcon, XIcon } from "lucide-react";
import type { StreamInfo } from "@teststand/contracts/observability";
import { errorMessage } from "../../lib/errors.js";
import { Button, cn, IconButton, Input, Select } from "../../ui/index.js";
import { formatHex, parseHex } from "../manual/widget-model.js";
import { rememberText } from "../manual/widgets.js";
import { sendBinding, type SendBinding } from "./control-bindings.js";
import { useMonitorStatic } from "./panel-kit.js";

type Ending = "" | "\r" | "\n" | "\r\n";
const ENDINGS: { value: Ending; label: string }[] = [
  { value: "", label: "无" },
  { value: "\r", label: "CR" },
  { value: "\n", label: "LF" },
  { value: "\r\n", label: "CRLF" }
];

function readList(key: string): string[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key: string, items: string[]): void {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(items)); } catch { /* not kept */ }
}

/** `text|hex:payload` keys a preset so a hex command stays hex. */
function presetOf(item: string): { hex: boolean; payload: string } {
  return item.startsWith("hex:")
    ? { hex: true, payload: item.slice(4) }
    : { hex: false, payload: item.replace(/^text:/, "") };
}

/**
 * Sends on a serial port from the panel that shows it (a serial assistant's send box): text or
 * hex, an optional line ending, the history of what was sent and saved commands. Only ports whose
 * device has a sending tool are offered; a port a test run holds is disabled.
 */
export function SendBar({ streams }: { streams: readonly StreamInfo[] }) {
  const { control, notify } = useMonitorStatic();
  const targets = streams.flatMap((stream) => {
    const binding = sendBinding(stream, control.toolsOf(stream.hardwareId));
    return binding ? [{ stream, binding }] : [];
  });
  const [chosen, setChosen] = useState<string>();
  const [hex, setHex] = useState(false);
  const [ending, setEnding] = useState<Ending>("\r\n");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [, setVersion] = useState(0);
  const target = targets.find((item) => item.stream.key === chosen) ?? targets[0];
  if (!target) return null;
  const { stream, binding } = target;
  const presetKey = `teststand.send.presets.${stream.hardwareId}/${stream.streamId}`;
  const historyKey = `teststand.send.history.${stream.hardwareId}/${stream.streamId}`;
  const locked = control.lockOf(stream.hardwareId);
  const parsed = hex ? parseHex(text) : undefined;
  const available: SendBinding[keyof SendBinding] = hex ? binding.hex : binding.text;
  const send = async (payload: string, asHex: boolean) => {
    const via = asHex ? binding.hex : binding.text;
    if (!via) return;
    const bytes = parseHex(payload);
    const data = asHex ? ("bytes" in bytes ? formatHex(bytes.bytes) : payload) : payload + ending;
    setBusy(true);
    try {
      await control.call(stream.hardwareId, via.tool, { ...via.fixed, [via.data]: data });
      rememberText(historyKey, `${asHex ? "hex" : "text"}:${payload}`);
    } catch (cause) {
      notify.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const presets = readList(presetKey);
  const history = readList(historyKey);
  const invalid = parsed !== undefined && "error" in parsed;
  return (
    <div role="group" aria-label="发送" className="grid shrink-0 gap-1 border-t border-line bg-surface-1 px-2 py-1">
      <div className="flex items-center gap-1">
        {targets.length > 1 && (
          <Select aria-label="发送端口" className="h-6 w-28 text-2xs" value={stream.key}
            onChange={(event) => setChosen(event.target.value)}>
            {targets.map((item) => (
              <option key={item.stream.key} value={item.stream.key}>{item.stream.streamId}</option>
            ))}
          </Select>
        )}
        <span className="inline-flex rounded-sm border border-line">
          {(["文本", "HEX"] as const).map((label, index) => (
            <button key={label} type="button" aria-pressed={hex === (index === 1)}
              disabled={index === 1 ? !binding.hex : !binding.text}
              className={cn("h-6 px-1.5 text-2xs", hex === (index === 1) ? "bg-signal text-signal-fg" : "text-fg-2")}
              onClick={() => setHex(index === 1)}>{label}</button>
          ))}
        </span>
        <Input aria-label={`发送到 ${stream.streamId}`} list={`${historyKey}-list`}
          className={cn("h-6 min-w-0 flex-1 font-mono text-xs", invalid && text && "border-fail")}
          placeholder={hex ? "AA 55 01" : "发送的文本"} value={text} disabled={Boolean(locked) || busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !invalid && text) void send(text, hex);
          }} />
        <datalist id={`${historyKey}-list`}>
          {history.map((item) => presetOf(item)).filter((item) => item.hex === hex)
            .map((item) => <option key={item.payload} value={item.payload} />)}
        </datalist>
        {!hex && (
          <Select aria-label="行结束" className="h-6 w-16 text-2xs" value={ending}
            onChange={(event) => setEnding(event.target.value as Ending)}>
            {ENDINGS.map((item) => <option key={item.label} value={item.value}>{item.label}</option>)}
          </Select>
        )}
        <IconButton label="保存为常用命令" size="icon-xs" variant="ghost" disabled={!text || invalid}
          onClick={() => {
            writeList(presetKey, [...new Set([...presets, `${hex ? "hex" : "text"}:${text}`])]);
            setVersion((v) => v + 1);
          }}>
          <StarIcon />
        </IconButton>
        <Button size="xs" variant="primary" disabled={!text || invalid || !available || Boolean(locked) || busy}
          title={locked} onClick={() => void send(text, hex)}>
          <SendIcon />发送
        </Button>
      </div>
      {(presets.length > 0 || locked || (invalid && text)) && (
        <div className="flex flex-wrap items-center gap-1 text-2xs">
          {locked && <span className="text-fail">{locked}，不能发送</span>}
          {invalid && text && parsed && "error" in parsed && <span className="text-fail">{parsed.error}</span>}
          {presets.map((item) => {
            const preset = presetOf(item);
            return (
              <span key={item} className="inline-flex items-center rounded-sm border border-line bg-surface-0">
                <button type="button" disabled={Boolean(locked) || busy} title={preset.hex ? "HEX" : "文本"}
                  className="px-1.5 font-mono text-fg-2 hover:text-fg"
                  onClick={() => void send(preset.payload, preset.hex)}>
                  {preset.payload}
                </button>
                <button type="button" aria-label={`删除常用命令 ${preset.payload}`} className="px-0.5 text-fg-3"
                  onClick={() => {
                    writeList(presetKey, presets.filter((entry) => entry !== item));
                    setVersion((v) => v + 1);
                  }}>
                  <XIcon className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
