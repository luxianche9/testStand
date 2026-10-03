import type { OpenCodeConnection } from "@teststand/contracts/operations";

type OpenCodeRequestHeaders = Record<string, string | string[]>;
export type OpenCodeAuthorization = (requestUrl: string, requestHeaders: OpenCodeRequestHeaders) => Promise<OpenCodeRequestHeaders>;

function isSameOrigin(value: string, expected: string): boolean {
  try { return new URL(value).origin === new URL(expected).origin; }
  catch { return false; }
}

/**
 * Adds OpenCode's Basic auth to the renderer's requests to the OpenCode server, so the renderer never
 * holds the password. The backend runs OpenCode on a new port at every start: a loopback origin that
 * is neither the backend nor the last known server asks the backend again (`agents.openCodeConnection`).
 */
export function createOpenCodeAuthorization(
  backendUrl: string,
  connection: () => Promise<OpenCodeConnection | null>
): OpenCodeAuthorization {
  let current: OpenCodeConnection | null = null;
  return async (requestUrl, requestHeaders) => {
    if (isSameOrigin(requestUrl, backendUrl)) return requestHeaders;
    if (!current || !isSameOrigin(requestUrl, current.url)) current = await connection().catch(() => null);
    if (!current || !isSameOrigin(requestUrl, current.url)) return requestHeaders;
    const headers = { ...requestHeaders };
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "authorization") delete headers[name];
    }
    headers.Authorization = `Basic ${Buffer.from(`${current.username}:${current.password}`, "utf8").toString("base64")}`;
    return headers;
  };
}
