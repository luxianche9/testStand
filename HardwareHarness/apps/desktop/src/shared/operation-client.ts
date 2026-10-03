import type { AppError, ErrorCategory, WireError } from "@hardwareharness/contracts/errors";
import { BYTES_RESULT_OPERATIONS, type OperationName } from "@hardwareharness/contracts/operations";
import type { LocalApiEndpoint } from "./desktop-ipc.js";

/** `POST /api/ops/{name}` of the Python service (design doc §9.4), with its named JSON body. Only
 * web globals, so the same code runs in the renderer and in main. */
export interface OperationClientOptions {
  endpoint(): Promise<LocalApiEndpoint>;
  /** Called when the endpoint was refused or unreachable, so the next call asks again. */
  forgetEndpoint?(): void;
  fetch?: typeof fetch;
}

export type OperationCall = (operation: OperationName, params?: object) => Promise<unknown>;

export function createOperationClient(options: OperationClientOptions): OperationCall {
  const request = options.fetch ?? fetch;
  return async (operation, params = {}) => {
    const api = await options.endpoint();
    let response: Response;
    try {
      response = await request(`${api.url}/api/ops/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
        body: JSON.stringify(operationBody(params))
      });
    } catch (error) {
      options.forgetEndpoint?.();
      throw appError("unavailable", `Backend unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 401 || response.status === 421) options.forgetEndpoint?.();
    const body = await response.json().catch(() => undefined) as unknown;
    if (response.ok && body !== undefined) {
      return BYTES_RESULT_OPERATIONS.includes(operation) && typeof body === "string" ? fromBase64(body) : body;
    }
    const error = (body as { error?: WireError } | undefined)?.error;
    if (error) throw fromWireError(error);
    throw appError("invalid_response", `Backend answered ${response.status} without a result`);
  };
}

/** The request as sent: `undefined` fields are left out and bytes go as base64. */
export function operationBody(params: object): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) body[name] = value instanceof Uint8Array ? toBase64(value) : value;
  }
  return body;
}

export function fromWireError(error: WireError | null | undefined): AppError {
  return appError(typeof error?.category === "string" ? error.category : "error", typeof error?.message === "string" ? error.message : "Request failed", error?.details);
}

function appError(category: ErrorCategory, message: string, details?: unknown): AppError {
  return Object.assign(new Error(message), { name: "AppError", category, ...(details === undefined ? {} : { details }) });
}

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
