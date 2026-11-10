import { type Duration, parseDuration } from "../duration.js";
import { GantryCode, gantryError } from "../errors.js";
import { defineMiddleware } from "../pipeline.js";
import type { CallToolResult, Middleware } from "../types.js";

export interface TimeoutOptions {
  /** Default limit for every tool. Default "30s". */
  default?: Duration;
  /** Per-tool overrides. */
  perTool?: Record<string, Duration>;
}

export class GantryTimeoutError extends Error {
  override readonly name = "GantryTimeoutError";
}

const human = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);

/**
 * Aborts `ctx.signal` and returns a TIMEOUT error when a call runs too long.
 * Handlers should pass the signal to their I/O; work that ignores it keeps
 * running in the background, so the message warns about side effects.
 */
export function timeout(options: TimeoutOptions = {}): Middleware {
  const defaultMs = parseDuration(options.default ?? "30s", "timeout.default");
  const perTool = new Map(
    Object.entries(options.perTool ?? {}).map(([k, v]) => [
      k,
      parseDuration(v, `timeout.perTool.${k}`),
    ]),
  );

  return defineMiddleware(
    async (ctx, next) => {
      const ms = perTool.get(ctx.tool.name) ?? defaultMs;
      let handle: unknown;
      const timedOut = new Promise<CallToolResult>((resolve) => {
        handle = ctx.clock.setTimeout(() => {
          ctx.abort(new GantryTimeoutError(`Timed out after ${human(ms)}`));
          ctx.emit({ type: "timeout", code: GantryCode.TIMEOUT, timeoutMs: ms });
          resolve(
            gantryError(
              GantryCode.TIMEOUT,
              `${ctx.tool.name} did not finish within ${human(ms)} and was stopped. It may have partly run; check the current state before retrying.`,
              { timeoutMs: ms },
            ),
          );
        }, ms);
      });
      const running = next();
      // The handler may still settle after the timeout; never leave that rejection unhandled.
      running.catch(() => {});
      try {
        return await Promise.race([running, timedOut]);
      } finally {
        ctx.clock.clearTimeout(handle);
      }
    },
    { gantryName: "timeout" },
  );
}
