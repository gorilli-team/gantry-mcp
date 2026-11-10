import { GantryCode, gantryError, getGantryPayload } from "../errors.js";
import { defineMiddleware } from "../pipeline.js";
import { DEFAULT_REDACT, type RedactRule, redact } from "../redact.js";
import type { GantryEvent, Middleware } from "../types.js";

export interface AuditOptions {
  /** Receives every event, already redacted. May be async. */
  sink: (event: GantryEvent) => void | Promise<void>;
  /** Extra keys (exact, case-insensitive) or patterns to redact. Defaults always apply. */
  redact?: RedactRule[];
  /** Include call arguments in "received" events. Default false. */
  includeArgs?: boolean;
  /** Include the tool result in "executed" events. Default false. */
  includeResult?: boolean;
  /**
   * Refuse the call when the sink fails to record "received". Default true:
   * no audit record, no execution.
   */
  failClosed?: boolean;
}

/**
 * Emits one structured event per stage (received, refused, approved,
 * executed, failed) with timing. Redaction happens before the sink sees
 * anything; tokens are never logged.
 */
export function audit(options: AuditOptions): Middleware {
  if (typeof options?.sink !== "function") throw new TypeError("audit: `sink` is required");
  const rules = [...DEFAULT_REDACT, ...(options.redact ?? [])];
  const failClosed = options.failClosed ?? true;
  const pendingReceived = new Map<string, Promise<void>>();
  let logError: (m: string, e?: unknown) => void = () => {};

  const deliver = (event: GantryEvent): Promise<void> =>
    Promise.resolve()
      .then(() => options.sink(redact(event, rules) as GantryEvent))
      .catch((error: unknown) => {
        logError(`audit sink failed for "${event.type}"`, error);
        throw error;
      });

  return defineMiddleware(
    async (ctx, next) => {
      const started = ctx.clock.now();
      ctx.emit({
        type: "received",
        ...(options.includeArgs ? { args: redact(ctx.args, rules) } : {}),
      });
      const recorded = pendingReceived.get(ctx.requestId);
      pendingReceived.delete(ctx.requestId);
      if (recorded) {
        try {
          await recorded;
        } catch {
          if (failClosed) {
            return gantryError(
              GantryCode.UNAVAILABLE,
              "The audit log is unavailable, so the call was not run. Try again later.",
            );
          }
        }
      }

      try {
        const result = await next();
        const durationMs = ctx.clock.now() - started;
        const payload = getGantryPayload(result);
        if (result.isError && payload) {
          ctx.emit({ type: "refused", code: payload.code, durationMs });
        } else if (result.isError) {
          ctx.emit({ type: "failed", durationMs });
        } else {
          ctx.emit({
            type: "executed",
            durationMs,
            ...(payload ? { code: payload.code } : {}),
            ...(options.includeResult ? { result: redact(result, rules) } : {}),
          });
        }
        return result;
      } catch (error) {
        ctx.emit({
          type: "failed",
          durationMs: ctx.clock.now() - started,
          error: error instanceof Error ? error.name : "Error",
        });
        throw error;
      }
    },
    {
      gantryName: "audit",
      init(api) {
        logError = (m, e) => api.logger.error(m, e);
        api.on((event) => {
          const delivery = deliver(event);
          if (event.type === "received") pendingReceived.set(event.requestId, delivery);
          else delivery.catch(() => {});
        });
      },
    },
  );
}
