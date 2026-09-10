/** Private process encoding. The renderer's structured-clone transformer stays transparent. */
type Encoded = unknown[];

export function encodeProcessValue(value: unknown): Encoded {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "number") return ["number",
    Number.isNaN(value) ? "nan" : value === Infinity ? "infinity" : value === -Infinity ? "-infinity" : Object.is(value, -0) ? "-zero" : value
  ];
  if (value instanceof Uint8Array) return ["bytes", Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64")];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (Array.isArray(value)) return ["array", value.map(encodeProcessValue)];
  if (typeof value === "object") return ["object", Object.entries(value).map(([key, entry]) => [key, encodeProcessValue(entry)])];
  throw new TypeError(`Unsupported process value: ${typeof value}`);
}

export function decodeProcessValue(value: unknown): unknown {
  if (!Array.isArray(value) || typeof value[0] !== "string") throw new Error("Invalid process value");
  const [tag, data] = value as [string, unknown];
  if (tag === "undefined" && value.length === 1) return undefined;
  if (tag === "null" && value.length === 1) return null;
  if (value.length !== 2) throw new Error("Invalid process value length");
  if (tag === "boolean" && typeof data === "boolean") return data;
  if (tag === "string" && typeof data === "string") return data;
  if (tag === "number") {
    if (typeof data === "number") return data;
    if (data === "nan") return NaN;
    if (data === "infinity") return Infinity;
    if (data === "-infinity") return -Infinity;
    if (data === "-zero") return -0;
  }
  if (tag === "bytes" && typeof data === "string") return new Uint8Array(Buffer.from(data, "base64"));
  if (tag === "date" && typeof data === "string") return new Date(data);
  if (tag === "array" && Array.isArray(data)) return data.map(decodeProcessValue);
  if (tag === "object" && Array.isArray(data)) {
    const result: Record<string, unknown> = {};
    for (const entry of data) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") throw new Error("Invalid process object entry");
      Object.defineProperty(result, entry[0], { value: decodeProcessValue(entry[1]), enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  throw new Error(`Invalid process value tag: ${tag}`);
}
