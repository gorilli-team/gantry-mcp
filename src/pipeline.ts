import { AnnotationViolationError, GantryCode, gantryError } from "./errors.js";
import type { CallContext, CallToolResult, Middleware, MiddlewareHooks, Next } from "./types.js";

export type Handler = (ctx: CallContext) => Promise<CallToolResult>;

/**
 * Composes middlewares around a handler, Koa style. Each middleware either
 * calls `next()` once or returns its own result.
 */
export function compose(middlewares: readonly Middleware[], handler: Handler): Handler {
  return (ctx) => {
    let index = -1;
    const dispatch = async (i: number): Promise<CallToolResult> => {
      if (i <= index) throw new Error("Gantry: next() called more than once in a middleware");
      index = i;
      const mw = middlewares[i];
      if (!mw) return handler(ctx);
      const next: Next = () => dispatch(i + 1);
      return mw(ctx, next);
    };
    return dispatch(0).catch((error: unknown) => {
      if (error instanceof AnnotationViolationError) {
        return gantryError(
          GantryCode.ANNOTATION_VIOLATION,
          `${error.message} The tool "${ctx.tool.name}" is declared read-only, so the write was blocked. Do not retry this call.`,
          { tool: ctx.tool.name },
        );
      }
      throw error;
    });
  };
}

/** Attaches hooks to a middleware function. */
export function defineMiddleware(
  fn: (ctx: CallContext, next: Next) => Promise<CallToolResult>,
  hooks: MiddlewareHooks = {},
): Middleware {
  return Object.assign(fn, hooks);
}
