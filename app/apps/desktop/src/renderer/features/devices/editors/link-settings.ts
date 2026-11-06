/** Settings of a `comm_link` device (devices/adapters/comm_link): which link it makes when it opens. */

export const LINK_TYPE = "comm_link";

export type LinkKind = "serial" | "tcp_client" | "tcp_server" | "udp";

export const LINK_KINDS: { value: LinkKind | ""; label: string }[] = [
  { value: "serial", label: "串口（COM / USB 转串口）" },
  { value: "tcp_client", label: "TCP 客户端（本机去连）" },
  { value: "tcp_server", label: "TCP 服务端（被测件来连）" },
  { value: "udp", label: "UDP" },
  { value: "", label: "不自动连接（用控制动作连）" }
];

export const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000,
  2000000];

/** The keys each kind of link reads; switching the kind drops the others. */
const KEYS: Record<LinkKind, readonly string[]> = {
  serial: ["port", "baudrate", "bytesize", "parity", "stopbits"],
  tcp_client: ["host", "port"],
  tcp_server: ["port", "bind"],
  udp: ["localPort", "host", "port"]
};
const ALL_KEYS = new Set(["link", ...Object.values(KEYS).flat()]);

const DEFAULTS: Record<LinkKind, Record<string, unknown>> = {
  serial: { port: "COM3", baudrate: 115200, bytesize: 8, parity: "N", stopbits: 1 },
  tcp_client: { host: "192.168.1.10", port: 502 },
  tcp_server: { port: 9000 },
  udp: { localPort: 9000 }
};

export function linkKind(settings: Record<string, unknown>): LinkKind | "" {
  const value = settings.link;
  return value === "serial" || value === "tcp_client" || value === "tcp_server" || value === "udp" ? value : "";
}

/** `settings` switched to `kind`: the link's keys start from defaults (keeping values that still apply). */
export function withLinkKind(settings: Record<string, unknown>, kind: LinkKind | ""): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(settings).filter(([key]) => !ALL_KEYS.has(key)));
  if (!kind) return rest;
  const kept = Object.fromEntries(KEYS[kind].filter((key) => key in settings && linkKind(settings) === kind)
    .map((key) => [key, settings[key]]));
  return { ...rest, link: kind, ...DEFAULTS[kind], ...kept };
}

/** One field's text turned into the value the plugin reads: numbers for numeric keys, trimmed text else. */
export function linkValue(key: string, text: string): unknown {
  const numeric = ["baudrate", "bytesize", "stopbits", "port", "localPort"].includes(key)
    && !(key === "port" && /^com/i.test(text.trim()));
  if (!numeric) return key === "port" || key === "parity" ? text.trim().toUpperCase() : text.trim();
  const value = Number(text);
  return Number.isFinite(value) ? value : text.trim();
}

/** What is wrong with the link settings, by key (shown under the field); empty when they can be used. */
export function linkIssues(settings: Record<string, unknown>): Record<string, string> {
  const kind = linkKind(settings);
  const issues: Record<string, string> = {};
  const port = (key: string, allowZero = false) => {
    const value = settings[key];
    const low = allowZero ? 0 : 1;
    if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > 65535) {
      issues[key] = `端口号 ${low}–65535`;
    }
  };
  if (kind === "serial") {
    if (typeof settings.port !== "string" || !/^COM[1-9][0-9]{0,2}$/.test(settings.port)) issues.port = "如 COM3";
    if (typeof settings.baudrate !== "number" || settings.baudrate < 50 || settings.baudrate > 4_000_000) {
      issues.baudrate = "50–4000000";
    }
  }
  if (kind === "tcp_client" || (kind === "udp" && settings.host)) {
    if (typeof settings.host !== "string" || !settings.host) issues.host = "IP 地址或主机名";
    port("port");
  }
  if (kind === "tcp_server") port("port");
  if (kind === "udp") port("localPort", true);
  return issues;
}
