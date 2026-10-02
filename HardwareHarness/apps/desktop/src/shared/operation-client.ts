import { OPERATIONS, type OperationName } from "@hardwareharness/contracts/application";
import type { AppError, ErrorCategory, WireError } from "@hardwareharness/contracts/errors";
import type { LocalApiEndpoint } from "./desktop-ipc.js";

/** `POST /api/ops/{name}` of the Python service (design doc §9.4), for the renderer (renderer
 * token) and main (host token). Only web globals, so the same code runs in both processes. */
export interface OperationClientOptions {
  endpoint(): Promise<LocalApiEndpoint>;
  /** Called when the endpoint was refused or unreachable, so the next call asks again. */
  forgetEndpoint?(): void;
  fetch?: typeof fetch;
}

export type OperationCall = (operation: OperationName, args: readonly unknown[]) => Promise<unknown>;

export function createOperationClient(options: OperationClientOptions): OperationCall {
  const request = options.fetch ?? fetch;
  return async (operation, args) => {
    const api = await options.endpoint();
    let response: Response;
    try {
      response = await request(`${api.url}/api/ops/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
        body: JSON.stringify(operationBody(operation, args))
      });
    } catch (error) {
      options.forgetEndpoint?.();
      throw appError("unavailable", `Backend unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 401 || response.status === 421) options.forgetEndpoint?.();
    const body = await response.json().catch(() => undefined) as unknown;
    if (response.ok && body !== undefined) return OPERATIONS[operation].returnsBytes && typeof body === "string" ? fromBase64(body) : body;
    const error = (body as { error?: WireError } | undefined)?.error;
    if (error) throw fromWireError(error);
    throw appError("invalid_response", `Backend answered ${response.status} without a result`);
  };
}

/** Positional arguments by their wire names; `undefined` is left out and bytes go as base64. */
export function operationBody(operation: OperationName, args: readonly unknown[]): Record<string, unknown> {
  const { params, bytes } = OPERATIONS[operation] as { params: readonly string[]; bytes: readonly string[] };
  if (args.length > params.length) throw new TypeError(`${operation} takes ${params.length} arguments`);
  const body: Record<string, unknown> = {};
  args.forEach((value, index) => {
    const name = params[index]!;
    if (value === undefined) return;
    body[name] = bytes.includes(name) && value instanceof Uint8Array ? toBase64(value) : value;
  });
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
