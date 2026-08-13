export type OpenCodeRequestHeaders = Record<string, string | string[]>;

function isSameOrigin(value: string, expected: string): boolean {
  try { return new URL(value).origin === new URL(expected).origin; }
  catch { return false; }
}

export function injectOpenCodeAuthorization(
  requestUrl: string,
  requestHeaders: OpenCodeRequestHeaders,
  connection: { url: string; password: string } | undefined
): OpenCodeRequestHeaders {
  if (!connection || !isSameOrigin(requestUrl, connection.url)) return requestHeaders;
  const headers = { ...requestHeaders };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "authorization") delete headers[name];
  }
  headers.Authorization = `Basic ${Buffer.from(`opencode:${connection.password}`, "utf8").toString("base64")}`;
  return headers;
}
