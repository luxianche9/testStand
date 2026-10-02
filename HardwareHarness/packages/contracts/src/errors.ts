import { z } from "zod";

export const errorCategorySchema = z.enum([
  "permission_denied",
  "invalid_argument",
  "unavailable",
  "conflict",
  "not_found",
  "validation_failed",
  "requires_project",
  "safe_stop_failed",
  "invalid_response",

  "loop_limit",
  "assertion_failed",
  "project_exists",
  "invalid_project",
  "project_uninitialized",
  "invalid_project_folder",
  "cancelled",
  "unknown_outcome",
  "error"
]);
export type ErrorCategory = z.infer<typeof errorCategorySchema>;

export interface AppError extends Error {
  category: ErrorCategory;
  details?: unknown;
}

export const wireErrorSchema = z.object({
  category: errorCategorySchema,
  message: z.string(),
  details: z.unknown().optional()
});
export type WireError = z.infer<typeof wireErrorSchema>;

export function appError(category: ErrorCategory, message: string, details?: unknown): AppError {
  return Object.assign(new Error(message), {
    name: "AppError",
    category,
    ...(details === undefined ? {} : { details })
  });
}

export function toWireError(error: unknown): WireError {
  const candidate = error as { category?: unknown; message?: unknown; details?: unknown } | null | undefined;
  const parsedCategory = errorCategorySchema.safeParse(candidate?.category);
  const category: ErrorCategory = parsedCategory.success ? parsedCategory.data : "error";
  const message = typeof candidate?.message === "string" ? candidate.message : String(error);
  return {
    category,
    message,
    ...(candidate && Object.hasOwn(candidate, "details") ? { details: candidate.details } : {})
  };
}
