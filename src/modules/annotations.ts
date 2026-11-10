import { AnnotationViolationError, GantryConfigError } from "../errors.js";
import { defineMiddleware } from "../pipeline.js";
import type { Middleware, ToolInfo } from "../types.js";

export interface AnnotationsOptions {
  /** Block writes from read-only tools through `ctx.fetch` and `ctx.clients`. Default true. */
  enforce?: boolean;
  /**
   * Refuse to register tools whose name suggests a write (`delete_`, `send_`,
   * `update_`, ...) without `readOnlyHint` or `destructiveHint`, and tools
   * that declare both. Default false.
   */
  strict?: boolean;
  /** Method names treated as writes on wrapped clients. Default: insert*, update*, delete*, ... */
  writeMethods?: Array<string | RegExp>;
  /** Tool name patterns that look like writes, for strict mode. */
  writeNames?: RegExp;
}

const DEFAULT_WRITE_METHODS: Array<string | RegExp> = [
  /^(insert|update|delete|remove|create|save|put|post|patch|set|drop|write|upsert|replace|destroy|truncate|bulk|increment|decrement|push|send|add|merge|alter|grant|revoke)/i,
];
const DEFAULT_WRITE_NAMES =
  /^(delete|remove|send|update|create|write|drop|insert|set|put|post|patch|cancel|pay|transfer|refund|archive|publish|deploy|move|rename|upload|grant|revoke|reset|purge)[_-]/i;
const SAFE_HTTP = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Enforces declared tool annotations. Only I/O that goes through
 * `ctx.fetch` and `ctx.clients` (from `gantry({ clients })`) is checked; it
 * cannot see arbitrary I/O in your handler.
 */
export function annotations(options: AnnotationsOptions = {}): Middleware {
  const enforce = options.enforce ?? true;
  const strict = options.strict ?? false;
  const writeMethods = options.writeMethods ?? DEFAULT_WRITE_METHODS;
  const writeNames = options.writeNames ?? DEFAULT_WRITE_NAMES;

  const isWriteMethod = (name: PropertyKey) =>
    typeof name === "string" &&
    writeMethods.some((m) =>
      typeof m === "string"
        ? m === name
        : new RegExp(m.source, m.flags.replace("g", "")).test(name),
    );

  const guard = <T>(value: T, path: string, cache: WeakMap<object, unknown>): T => {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return value;
    const target = value as unknown as object;
    const cached = cache.get(target);
    if (cached) return cached as T;
    const proxy = new Proxy(target, {
      get(obj, prop, _receiver) {
        const inner = Reflect.get(obj, prop, obj);
        const where = `${path}.${String(prop)}`;
        if (typeof inner === "function") {
          if (isWriteMethod(prop)) {
            return () => {
              throw new AnnotationViolationError(`Blocked write ${where}().`);
            };
          }
          return (...args: unknown[]) =>
            guard(Reflect.apply(inner, obj, args), `${where}()`, cache);
        }
        return guard(inner, where, cache);
      },
      set() {
        throw new AnnotationViolationError(`Blocked assignment on ${path}.`);
      },
      deleteProperty() {
        throw new AnnotationViolationError(`Blocked delete on ${path}.`);
      },
    });
    cache.set(target, proxy);
    return proxy as T;
  };

  return defineMiddleware(
    async (ctx, next) => {
      if (!enforce || ctx.tool.annotations.readOnlyHint !== true) return next();
      const baseFetch = ctx.fetch;
      ctx.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const method = (
          init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")
        ).toUpperCase();
        if (!SAFE_HTTP.has(method)) throw new AnnotationViolationError(`Blocked HTTP ${method}.`);
        return baseFetch(input, init);
      }) as typeof fetch;
      const cache = new WeakMap<object, unknown>();
      const clients: Record<string, unknown> = {};
      for (const [name, client] of Object.entries(ctx.clients))
        clients[name] = guard(client, name, cache);
      ctx.clients = clients;
      return next();
    },
    {
      gantryName: "annotations",
      onRegister(tool: ToolInfo) {
        if (!strict) return;
        const { readOnlyHint, destructiveHint } = tool.annotations;
        if (readOnlyHint === true && destructiveHint === true) {
          throw new GantryConfigError(
            `Tool "${tool.name}" cannot be both readOnlyHint and destructiveHint.`,
          );
        }
        if (
          writeNames.test(tool.name) &&
          readOnlyHint === undefined &&
          destructiveHint === undefined
        ) {
          throw new GantryConfigError(
            `Tool "${tool.name}" looks like a write but declares no annotations. Set destructiveHint (true or false) or readOnlyHint.`,
          );
        }
      },
    },
  );
}
