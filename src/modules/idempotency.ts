import { createHash } from "node:crypto";
import { sleep } from "../clock.js";
import { type Duration, parseDuration } from "../duration.js";
import { GantryCode, gantryError, LockBusyError } from "../errors.js";
import { defineMiddleware } from "../pipeline.js";
import type { CallContext, CallToolResult, Middleware, ToolInfo } from "../types.js";

export interface IdempotencyOptions {
  /** How long a successful result is replayed. Default "24h". */
  ttl?: Duration;
  /** Whose calls are deduplicated together. Default "principal". */
  scope?: "principal" | "session" | "global";
  /** Which tools are deduplicated. Default: every tool not marked `readOnlyHint`. */
  onlyFor?: (tool: ToolInfo) => boolean;
  /** How long a duplicate waits for the first call to finish. Default "30s". */
  waitFor?: Duration;
  /** Lock lifetime, the upper bound of a single execution. Default "10m". */
  lockTtl?: Duration;
  /** Key prefix in the store. Default "gantry:idem". */
  prefix?: string;
}

interface StoredResult {
  argsHash: string;
  result: CallToolResult;
}

export const IDEMPOTENCY_KEY_ARG = "_idempotencyKey";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Same scope + tool + argsHash (or an explicit `_idempotencyKey`) within the
 * TTL returns the stored result instead of running again. Concurrent
 * duplicates wait for the first call. Only successful results are stored.
 */
export function idempotency(options: IdempotencyOptions = {}): Middleware {
  const ttl = parseDuration(options.ttl ?? "24h", "idempotency.ttl");
  const waitFor = parseDuration(options.waitFor ?? "30s", "idempotency.waitFor");
  const lockTtl = parseDuration(options.lockTtl ?? "10m", "idempotency.lockTtl");
  const scope = options.scope ?? "principal";
  const prefix = options.prefix ?? "gantry:idem";
  const applies = options.onlyFor ?? ((tool: ToolInfo) => tool.annotations.readOnlyHint !== true);
  const inFlight = new Map<string, { argsHash: string; running: Promise<CallToolResult> }>();

  const scopeId = (ctx: CallContext) =>
    scope === "global"
      ? "*"
      : scope === "session"
        ? // The principal is part of the session scope so session ids cannot collide across callers.
          `s:${ctx.principal}\u0000${ctx.sessionId ?? ""}`
        : `p:${ctx.principal}`;

  const replay = (ctx: CallContext, stored: StoredResult): CallToolResult => {
    if (stored.argsHash !== ctx.argsHash) {
      return gantryError(
        GantryCode.IDEMPOTENCY_CONFLICT,
        `The idempotency key was already used for ${ctx.tool.name} with different arguments. Use a new key for a new operation.`,
      );
    }
    ctx.emit({ type: "replayed" });
    return { ...stored.result, _meta: { ...(stored.result._meta ?? {}), "gantry/replayed": true } };
  };

  return defineMiddleware(
    async (ctx, next) => {
      if (!applies(ctx.tool)) return next();
      const explicit = ctx.reserved[IDEMPOTENCY_KEY_ARG];
      const id = typeof explicit === "string" ? `k:${sha256(explicit)}` : `h:${ctx.argsHash}`;
      const key = `${prefix}:${sha256(`${scopeId(ctx)}\u0000${ctx.tool.name}\u0000${id}`)}`;

      const unavailable = () =>
        gantryError(
          GantryCode.UNAVAILABLE,
          "Duplicate protection is unavailable, so the call was not run. Try again later.",
        );

      const deadline = ctx.clock.now() + waitFor;
      let delay = 25;
      for (;;) {
        let stored: StoredResult | undefined;
        try {
          stored = (await ctx.store.get(key)) as StoredResult | undefined;
        } catch {
          return unavailable();
        }
        if (stored) return replay(ctx, stored);

        let release: (() => Promise<void>) | undefined;
        try {
          release = await ctx.store.lock(key, lockTtl);
        } catch (error) {
          if (!(error instanceof LockBusyError)) return unavailable();
        }

        if (release) {
          try {
            // Another instance may have finished between our read and the lock.
            const raced = (await ctx.store.get(key)) as StoredResult | undefined;
            if (raced) return replay(ctx, raced);
            const running = next();
            inFlight.set(key, { argsHash: ctx.argsHash, running });
            const result = await running;
            if (!result.isError) {
              try {
                await ctx.store.set(
                  key,
                  { argsHash: ctx.argsHash, result } satisfies StoredResult,
                  ttl,
                );
              } catch (error) {
                ctx.emit({
                  type: "idempotency_store_failed",
                  error: error instanceof Error ? error.name : "Error",
                });
              }
            }
            return result;
          } catch (error) {
            if (inFlight.has(key)) throw error;
            return unavailable();
          } finally {
            inFlight.delete(key);
            await release().catch(() => {});
          }
        }

        // Someone else holds the lock: wait for their result.
        const local = inFlight.get(key);
        if (local) {
          // Same key, different arguments: refuse now rather than hand back another call's result.
          if (local.argsHash !== ctx.argsHash) {
            return replay(ctx, { argsHash: local.argsHash, result: { content: [] } });
          }
          const result = await local.running.catch(() => undefined);
          if (result && !result.isError) return replay(ctx, { argsHash: local.argsHash, result });
          continue;
        }
        if (ctx.clock.now() >= deadline || ctx.signal.aborted) {
          return gantryError(
            GantryCode.DUPLICATE_IN_FLIGHT,
            `An identical ${ctx.tool.name} call is still running. Wait for it to finish, then retry to get its result.`,
          );
        }
        try {
          await sleep(
            ctx.clock,
            Math.min(delay, Math.max(1, deadline - ctx.clock.now())),
            ctx.signal,
          );
        } catch {
          // Aborted: loop once more to return DUPLICATE_IN_FLIGHT.
        }
        delay = Math.min(delay * 2, 1000);
      }
    },
    {
      gantryName: "idempotency",
      reservedArgs: (tool): Record<string, Record<string, unknown>> =>
        applies(tool)
          ? {
              [IDEMPOTENCY_KEY_ARG]: {
                type: "string",
                description:
                  "Optional. A unique key for this operation; retries with the same key return the first result instead of running again.",
              },
            }
          : {},
    },
  );
}
