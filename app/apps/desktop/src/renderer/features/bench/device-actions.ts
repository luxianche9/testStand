import type { ToolCatalogItem } from "@teststand/contracts/devices";

/** What a device can be asked to do from its card: its own tools, without the platform's
 *  management tools and the stream plumbing every plugin carries. */
export function deviceActions(tools: ToolCatalogItem[], deviceId: string | undefined): ToolCatalogItem[] {
  if (!deviceId) return [];
  return tools.filter((tool) => tool.deviceId === deviceId && tool.kind === "hardware"
    && !/_stream_read$/.test(tool.remoteName));
}

/** The tool name without the adapter's prefix (`pci1762_set_relay` → `set_relay`); every tool of
 *  one device shares that prefix. */
export function actionName(tool: ToolCatalogItem, siblings: ToolCatalogItem[]): string {
  const prefix = /^([a-z0-9]+)_/.exec(tool.remoteName)?.[1];
  const shared = prefix && siblings.every((item) => item.remoteName.startsWith(`${prefix}_`));
  return shared ? tool.remoteName.slice(prefix.length + 1) : tool.remoteName;
}

type Semantics = { label: string; tone: "signal" | "neutral" | "pass" };

/** `actuate` changes outputs; `read` only reads; `safe` drives outputs to their safe values. */
export function actionKind(tool: ToolCatalogItem): Semantics {
  const kind = tool.contractMetadata?.operationSemantics?.kind;
  if (kind === "actuate") return { label: "动作", tone: "signal" };
  if (kind === "safe") return { label: "安全", tone: "pass" };
  return { label: "读取", tone: "neutral" };
}
