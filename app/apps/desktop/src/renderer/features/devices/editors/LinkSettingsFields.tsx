import { Input, Select } from "../../../ui";
import { EditorField } from "./EditorField.js";
import {
  BAUD_RATES, LINK_KINDS, linkIssues, linkKind, linkValue, withLinkKind, type LinkKind
} from "./link-settings.js";

/**
 * 链路: how a communication-link device connects when it opens — a COM port with its line settings, a TCP
 * client or server, or UDP. Edits the device's settings object, the same one the JSON field shows.
 */
export function LinkSettingsFields({ settings, onChange }: {
  settings: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
}) {
  const kind = linkKind(settings);
  const issues = linkIssues(settings);
  const text = (key: string) => (settings[key] === undefined ? "" : String(settings[key]));
  const set = (key: string, value: string) => onChange({ ...settings, [key]: linkValue(key, value) });
  const field = (key: string, label: string, placeholder?: string) => (
    <EditorField key={key} label={label} error={issues[key]}>
      <Input aria-label={label} className="font-mono" value={text(key)} placeholder={placeholder}
        onChange={(event) => set(key, event.target.value)} />
    </EditorField>
  );
  return (
    <>
      <EditorField label="连接方式" span>
        <Select aria-label="连接方式" value={kind}
          onChange={(event) => onChange(withLinkKind(settings, event.target.value as LinkKind | ""))}>
          {LINK_KINDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </Select>
      </EditorField>
      {kind === "serial" && (
        <>
          {field("port", "COM 口", "COM3")}
          <EditorField label="波特率" error={issues.baudrate}>
            <Input aria-label="波特率" className="font-mono" list="link-baud-rates" value={text("baudrate")}
              onChange={(event) => set("baudrate", event.target.value)} />
            <datalist id="link-baud-rates">{BAUD_RATES.map((rate) => <option key={rate} value={rate} />)}</datalist>
          </EditorField>
          <EditorField label="数据位 / 校验 / 停止位">
            <div className="flex gap-1.5">
              <Select aria-label="数据位" value={text("bytesize")}
                onChange={(event) => set("bytesize", event.target.value)}>
                {[8, 7, 6, 5].map((bits) => <option key={bits} value={bits}>{bits}</option>)}
              </Select>
              <Select aria-label="校验" value={text("parity")} onChange={(event) => set("parity", event.target.value)}>
                {[["N", "无"], ["E", "偶"], ["O", "奇"], ["M", "标记"], ["S", "空格"]].map(([value, label]) => (
                  <option key={value} value={value}>{value} {label}</option>
                ))}
              </Select>
              <Select aria-label="停止位" value={text("stopbits")}
                onChange={(event) => set("stopbits", event.target.value)}>
                {[1, 1.5, 2].map((bits) => <option key={bits} value={bits}>{bits}</option>)}
              </Select>
            </div>
          </EditorField>
        </>
      )}
      {kind === "tcp_client" && <>{field("host", "对方地址", "192.168.1.10")}{field("port", "对方端口", "502")}</>}
      {kind === "tcp_server" && <>{field("port", "监听端口", "9000")}{field("bind", "监听地址", "0.0.0.0（所有网卡）")}</>}
      {kind === "udp" && (
        <>
          {field("localPort", "本机端口", "0 = 任意")}
          {field("host", "对方地址", "留空：回复最后的发送方")}
          {field("port", "对方端口", "留空：回复最后的发送方")}
        </>
      )}
    </>
  );
}

