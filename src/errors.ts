import type { CallToolResult } from "./types.js";

/** Machine-readable codes for every refusal Gantry produces. */
export const GantryCode = {
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  APPROVAL_DENIED: "APPROVAL_DENIED",
  APPROVAL_EXPIRED: "APPROVAL_EXPIRED",
  APPROVAL_INVALID: "APPROVAL_INVALID",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  OUTPUT_TRUNCATED: "OUTPUT_TRUNCATED",
  OUTPUT_TOO_LARGE: "OUTPUT_TOO_LARGE",
  ANNOTATION_VIOLATION: "ANNOTATION_VIOLATION",
  DUPLICATE_IN_FLIGHT: "DUPLICATE_IN_FLIGHT",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export type GantryCode = (typeof GantryCode)[keyof typeof GantryCode];

export interface GantryErrorPayload {
  code: GantryCode;
  [key: string]: unknown;
}

/**
 * Builds a refusal as a tool result (not a protocol error), so every client
 * shows it to the model. `text` should say what happened and what to do next.
 */
export function gantryError(
  code: GantryCode,
  text: string,
  details: Record<string, unknown> = {},
): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: { gantry: { ...details, code } },
  };
}

/** Reads the Gantry payload of a result, if it carries one. */
export function getGantryPayload(result: unknown): GantryErrorPayload | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as { structuredContent?: { gantry?: unknown }; _meta?: { gantry?: unknown } };
  const payload = r.structuredContent?.gantry ?? r._meta?.gantry;
  if (
    payload &&
    typeof payload === "object" &&
    typeof (payload as { code?: unknown }).code === "string"
  ) {
    return payload as GantryErrorPayload;
  }
  return undefined;
}

/**
 * Thrown by wrapped clients and helpers when a call breaks a declared rule.
 * The pipeline turns it into an `ANNOTATION_VIOLATION` result.
 */
export class AnnotationViolationError extends Error {
  override readonly name = "AnnotationViolationError";
}

/** Thrown by a store when a lock is already held. */
export class LockBusyError extends Error {
  override readonly name = "LockBusyError";
}

/** Thrown when Gantry is misconfigured. Always raised at startup, never per call. */
export class GantryConfigError extends Error {
  override readonly name = "GantryConfigError";
}
