import { type ParsedRate, parseRate, type Rate } from "../duration.js";
import { GantryCode, gantryError } from "../errors.js";
import { defineMiddleware } from "../pipeline.js";
import type { CallContext, Middleware } from "../types.js";

export interface RateLimitOptions {
  /** Limit per principal across all tools, e.g. "60/min". */
  perPrincipal?: Rate;
  /** Limits per tool name, counted per principal, e.g. { send_email: "10/hour" }. */
  perTool?: Record<string, Rate>;
  /** Limit per MCP session (falls back to the principal when there is no session). */
  perSession?: Rate;
  /** Limit across every caller. */
  global?: Rate;
  /** Custom bucket: return undefined to skip it for a call. */
  key?: { by: (ctx: CallContext) => string | undefined; rate: Rate; name?: string };
  /** Key prefix in the store. Default "gantry:rl". */
  prefix?: string;
}

interface Bucket {
  scope: string;
  id: string;
  rate: ParsedRate;
}

const describe = (r: ParsedRate) => `${r.limit} per ${r.windowMs / 1000}s`;

/**
 * Sliding-window counter per principal, tool, session or custom key. It only
 * needs the store's atomic `incr`, so it stays correct on shared stores.
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  const prefix = options.prefix ?? "gantry:rl";
  const perPrincipal = options.perPrincipal
    ? parseRate(options.perPrincipal, "rateLimit.perPrincipal")
    : undefined;
  const perSession = options.perSession
    ? parseRate(options.perSession, "rateLimit.perSession")
    : undefined;
  const global = options.global ? parseRate(options.global, "rateLimit.global") : undefined;
  const perTool = new Map(
    Object.entries(options.perTool ?? {}).map(([k, v]) => [
      k,
      parseRate(v, `rateLimit.perTool.${k}`),
    ]),
  );
  const custom = options.key
    ? { ...options.key, parsed: parseRate(options.key.rate, "rateLimit.key") }
    : undefined;
  if (!perPrincipal && !perSession && !global && perTool.size === 0 && !custom) {
    throw new TypeError("rateLimit: configure at least one limit");
  }

  const bucketsFor = (ctx: CallContext): Bucket[] => {
    const out: Bucket[] = [];
    if (global) out.push({ scope: "global", id: "*", rate: global });
    if (perPrincipal) out.push({ scope: "principal", id: ctx.principal, rate: perPrincipal });
    if (perSession) {
      out.push({
        scope: "session",
        id: `${ctx.principal}\u0000${ctx.sessionId ?? ""}`,
        rate: perSession,
      });
    }
    const tool = perTool.get(ctx.tool.name);
    if (tool) out.push({ scope: `tool:${ctx.tool.name}`, id: ctx.principal, rate: tool });
    if (custom) {
      const id = custom.by(ctx);
      if (id !== undefined)
        out.push({ scope: `key:${custom.name ?? "custom"}`, id, rate: custom.parsed });
    }
    return out;
  };

  return defineMiddleware(
    async (ctx, next) => {
      const now = ctx.clock.now();
      const taken: string[] = [];
      try {
        for (const bucket of bucketsFor(ctx)) {
          const { limit, windowMs } = bucket.rate;
          const window = Math.floor(now / windowMs);
          const elapsed = now - window * windowMs;
          const base = `${prefix}:${bucket.scope}:${encodeURIComponent(bucket.id)}`;
          const prev = Number((await ctx.store.get(`${base}:${window - 1}`)) ?? 0);
          const curKey = `${base}:${window}`;
          const cur = await ctx.store.incr(curKey, 1, windowMs * 2);
          taken.push(curKey);
          const weight = 1 - elapsed / windowMs;
          if (prev * weight + cur > limit) {
            const retryMs = retryAfterMs({ prev, cur: cur - 1, limit, windowMs, elapsed });
            const retryAfterSeconds = Math.max(1, Math.ceil(retryMs / 1000));
            await rollback(ctx, taken);
            ctx.emit({
              type: "rate_limited",
              code: GantryCode.RATE_LIMITED,
              scope: bucket.scope,
              retryAfterSeconds,
            });
            return gantryError(
              GantryCode.RATE_LIMITED,
              `Rate limit reached for ${ctx.tool.name} (${describe(bucket.rate)}, ${bucket.scope}). Retry after ${retryAfterSeconds}s.`,
              { retryAfterSeconds, scope: bucket.scope, limit, windowMs },
            );
          }
        }
      } catch {
        await rollback(ctx, taken).catch(() => {});
        return gantryError(
          GantryCode.UNAVAILABLE,
          "Rate limiting is unavailable, so the call was refused. Try again later.",
        );
      }
      return next();
    },
    { gantryName: "rateLimit" },
  );
}

async function rollback(ctx: CallContext, keys: string[]) {
  for (const key of keys.splice(0)) await ctx.store.incr(key, -1, 1);
}

/** Time until one more call fits under the sliding-window estimate. */
export function retryAfterMs(p: {
  prev: number;
  cur: number;
  limit: number;
  windowMs: number;
  elapsed: number;
}) {
  const { prev, cur, limit, windowMs, elapsed } = p;
  // Need: prev * (1 - (elapsed + t) / W) + cur + 1 <= limit, within this window...
  if (cur + 1 <= limit && prev > 0) {
    const t = windowMs * (1 - (limit - cur - 1) / prev) - elapsed;
    if (t <= windowMs - elapsed) return Math.max(1, t);
  }
  // ...or in the next window, where this window's count becomes `prev`.
  const rest = windowMs - elapsed;
  if (cur <= limit - 1) return rest;
  return rest + Math.max(0, windowMs * (1 - (limit - 1) / cur));
}
