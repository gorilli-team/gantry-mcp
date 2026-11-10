import { randomUUID } from "node:crypto";
import { hashArgs } from "./canonical.js";
import { type Clock, systemClock } from "./clock.js";
import { GantryCode, GantryConfigError, gantryError } from "./errors.js";
import { compose, type Handler } from "./pipeline.js";
import { recommended } from "./recommended.js";
import { reservedValues, withReservedArgs } from "./schema.js";
import { memoryStore } from "./store/memory.js";
import type { Store } from "./store/types.js";
import type {
  CallContext,
  CallToolResult,
  ClientCapabilities,
  ElicitRequest,
  ElicitResult,
  GantryApi,
  GantryEvent,
  GantryEventInput,
  Logger,
  Middleware,
  PrincipalRequest,
  ToolAnnotations,
  ToolInfo,
} from "./types.js";

const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";

/** The subset of `McpServer` (SDK v1 or v2) Gantry relies on. */
export interface McpServerLike {
  registerTool(
    name: string,
    config: Record<string, unknown>,
    cb: (...args: never[]) => unknown,
  ): unknown;
  connect?(transport: unknown): Promise<void>;
  server?: {
    getClientCapabilities?(): unknown;
    getClientVersion?(): { name?: string } | undefined;
    elicitInput?(params: unknown, options?: unknown): Promise<unknown>;
  };
}

export interface GantryOptions {
  /** Shared state for all modules. Default: `memoryStore()`. */
  store?: Store;
  /**
   * Resolves who is calling. Throwing refuses the call.
   * Default: `authInfo.clientId`, else "anonymous".
   */
  principal?: (req: PrincipalRequest) => string | Promise<string>;
  /** Middlewares, run in order. See `recommended()`. */
  use?: Middleware[];
  /** Clients exposed to handlers as `ctx.gantry.clients`; modules may wrap them. */
  clients?: Record<string, unknown>;
  clock?: Clock;
  logger?: Logger;
  /** Listener for every Gantry event. Same as `g.on(listener)`. */
  onEvent?: (event: GantryEvent) => void;
}

export interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: user handlers are typed by the SDK overloads.
type AnyHandler = (...args: any[]) => unknown;

/** Context passed to handlers: the SDK context plus `gantry`. */
export type WithGantry<T> = T & { gantry: CallContext };

const consoleLogger: Logger = {
  warn: (m) => console.warn(`[gantry] ${m}`),
  error: (m, e) => console.error(`[gantry] ${m}`, e ?? ""),
};

export class Gantry {
  readonly server: McpServerLike;
  readonly middlewares: readonly Middleware[];
  readonly logger: Logger;
  #store: Store;
  #clock: Clock;
  #principal: NonNullable<GantryOptions["principal"]>;
  #listeners = new Set<(event: GantryEvent) => void>();
  #clients: Record<string, unknown>;
  #wrapped = new Set<string>();
  /** Test hooks, used by `@gorilli/gantry-mcp/testing`. */
  _testing: {
    principal?: string;
    clientCapabilities?: ClientCapabilities;
    elicit?: (req: ElicitRequest) => Promise<ElicitResult>;
  } = {};

  constructor(server: McpServerLike, options: GantryOptions = {}) {
    if (!server || typeof server.registerTool !== "function") {
      throw new GantryConfigError("gantry(server): expected an McpServer with registerTool()");
    }
    this.server = server;
    this.#store = options.store ?? memoryStore();
    this.#clock = options.clock ?? systemClock;
    this.#store.useClock?.(this.#clock);
    this.logger = options.logger ?? consoleLogger;
    this.#principal = options.principal ?? ((req) => req.authInfo?.clientId ?? "anonymous");
    this.#clients = options.clients ?? {};
    this.middlewares = [...(options.use ?? [])];
    for (const mw of this.middlewares) {
      if (typeof mw !== "function")
        throw new GantryConfigError("gantry: every `use` entry must be a middleware function");
    }
    if (options.onEvent) this.#listeners.add(options.onEvent);
    const self = this;
    const api: GantryApi = {
      get store() {
        return self.#store;
      },
      get clock() {
        return self.#clock;
      },
      on: (l) => this.on(l),
      logger: this.logger,
    };
    for (const mw of this.middlewares) mw.init?.(api);
    this.#watchTransport();
  }

  get store(): Store {
    return this.#store;
  }

  get clock(): Clock {
    return this.#clock;
  }

  /** Replaces the clock (used by the test harness). */
  useClock(clock: Clock): void {
    this.#clock = clock;
    this.#store.useClock?.(clock);
  }

  /** Subscribes to the event stream. Returns an unsubscribe function. */
  on(listener: (event: GantryEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Same signature as `server.registerTool()`, with the pipeline around the handler. */
  tool(name: string, config: ToolConfig, handler: AnyHandler): unknown {
    const info = this.#toolInfo(name, config);
    const hasInput = config.inputSchema !== undefined;
    const reserved = this.#reservedArgs(info);
    let finalConfig: Record<string, unknown> = config;
    if (Object.keys(reserved).length > 0) {
      if (this.#isV2()) {
        finalConfig = { ...config, inputSchema: withReservedArgs(config.inputSchema, reserved) };
      } else {
        this.logger.warn(
          `Tool "${name}": SDK v1 cannot extend input schemas. Declare ${Object.keys(reserved).join(", ")} as optional string fields to use them.`,
        );
      }
    }
    const usesWrappedSchema = finalConfig !== config;
    const run = this.#buildRunner(info, (ctx, sdkCtx) =>
      hasInput ? handler(ctx.args, sdkCtx) : handler(sdkCtx),
    );
    const cb =
      usesWrappedSchema || hasInput
        ? (args: unknown, sdkCtx: unknown) => run(args, sdkCtx)
        : (sdkCtx: unknown) => run(undefined, sdkCtx);
    this.#wrapped.add(name);
    return this.server.registerTool(name, finalConfig, cb as never);
  }

  /**
   * Wraps tools already registered on the server (all of them, or `names`).
   * Relies on the SDK's registered tool `update()`; reserved arguments are not
   * added to existing schemas, so pass them via request `_meta` or declare them.
   */
  wrapExisting(names?: string[]): string[] {
    const registry = (this.server as { _registeredTools?: Record<string, RegisteredToolLike> })
      ._registeredTools;
    if (!registry)
      throw new GantryConfigError("wrapExisting: this server does not expose registered tools");
    const done: string[] = [];
    for (const [name, tool] of Object.entries(registry)) {
      if (names && !names.includes(name)) continue;
      if (this.#wrapped.has(name)) continue;
      const original = tool.handler ?? tool.callback;
      if (typeof original !== "function" || typeof tool.update !== "function") {
        throw new GantryConfigError(`wrapExisting: cannot wrap tool "${name}"`);
      }
      const info = this.#toolInfo(name, { annotations: tool.annotations, _meta: tool._meta });
      const hasInput = tool.inputSchema !== undefined;
      const run = this.#buildRunner(info, (ctx, sdkCtx) =>
        hasInput ? original(ctx.args, sdkCtx) : original(sdkCtx),
      );
      const callback = hasInput
        ? (args: unknown, sdkCtx: unknown) => run(args, sdkCtx)
        : (sdkCtx: unknown) => run(undefined, sdkCtx);
      tool.update({ callback });
      this.#wrapped.add(name);
      done.push(name);
    }
    if (names) {
      const missing = names.filter((n) => !done.includes(n) && !this.#wrapped.has(n));
      if (missing.length)
        throw new GantryConfigError(`wrapExisting: unknown tools ${missing.join(", ")}`);
    }
    return done;
  }

  #toolInfo(name: string, config: Pick<ToolConfig, "annotations" | "_meta">): ToolInfo {
    const info: ToolInfo = {
      name,
      annotations: Object.freeze({ ...(config.annotations ?? {}) }),
      meta: Object.freeze({ ...(config._meta ?? {}) }),
    };
    for (const mw of this.middlewares) mw.onRegister?.(info);
    return info;
  }

  #reservedArgs(info: ToolInfo): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const mw of this.middlewares) Object.assign(out, mw.reservedArgs?.(info) ?? {});
    return out;
  }

  #isV2(): boolean {
    return (
      typeof (this.server as { toolInputSchemaJson?: unknown }).toolInputSchemaJson === "function"
    );
  }

  #watchTransport(): void {
    if (this.#store.kind !== "memory" || typeof this.server.connect !== "function") return;
    const connect = this.server.connect.bind(this.server);
    this.server.connect = async (transport: unknown) => {
      const ctorName = (transport as { constructor?: { name?: string } })?.constructor?.name ?? "";
      if (/http/i.test(ctorName)) {
        this.logger.warn(
          `memoryStore() is process-local but the server uses ${ctorName}. Run a single instance or use a shared store (Redis, MongoDB) so limits, idempotency and approvals hold across instances.`,
        );
      }
      return connect(transport);
    };
  }

  #emit(base: Omit<GantryEvent, "type" | "at">, event: GantryEventInput): void {
    const full = { ...base, at: this.#clock.now(), ...event } as GantryEvent;
    for (const listener of this.#listeners) {
      try {
        listener(full);
      } catch (error) {
        this.logger.error("event listener threw", error);
      }
    }
  }

  #buildRunner(
    info: ToolInfo,
    invoke: (ctx: CallContext, sdkCtx: unknown) => unknown,
  ): (args: unknown, sdkCtx: unknown) => Promise<CallToolResult> {
    const handler: Handler = async (ctx) => {
      const sdkCtx = handlerContexts.get(ctx) ?? {};
      return (await invoke(ctx, sdkCtx)) as CallToolResult;
    };
    const pipeline = compose(this.middlewares, handler);

    return async (args, rawCtx) => {
      const sdk = (rawCtx ?? {}) as SdkContextLike;
      const requestId = randomUUID();
      // An empty session id means no session.
      const sessionId = sdk.sessionId ? sdk.sessionId : undefined;
      const meta = sdk.mcpReq?._meta ?? sdk._meta;
      const reserved = {
        ...reservedFromMeta(meta),
        ...((args && typeof args === "object" && reservedValues.get(args)) || {}),
      };
      const req: PrincipalRequest = {
        authInfo: sdk.http?.authInfo ?? sdk.authInfo,
        sessionId,
        requestId,
        tool: info.name,
        meta,
        sdk: rawCtx,
      };

      let principal: string;
      try {
        principal = this._testing.principal ?? (await this.#principal(req));
        if (typeof principal !== "string" || principal.length === 0)
          throw new Error("empty principal");
      } catch (error) {
        this.logger.error(`principal resolver failed for tool "${info.name}"`, error);
        return gantryError(
          GantryCode.UNAVAILABLE,
          "The server could not identify the caller, so the call was refused. Do not retry until the user re-authenticates.",
        );
      }

      let argsHash: string;
      try {
        argsHash = hashArgs(args);
      } catch {
        return gantryError(
          GantryCode.UNAVAILABLE,
          "Arguments could not be hashed. Send plain JSON values.",
        );
      }

      const controller = new AbortController();
      const upstream: AbortSignal | undefined = sdk.mcpReq?.signal ?? sdk.signal;
      if (upstream) {
        if (upstream.aborted) controller.abort(upstream.reason);
        else
          upstream.addEventListener("abort", () => controller.abort(upstream.reason), {
            once: true,
          });
      }

      const capabilities = this.#capabilities(sdk);
      const base = { tool: info.name, principal, requestId, sessionId };
      const state = new Map<string, unknown>();
      const ctx: CallContext = {
        tool: info,
        args,
        argsHash,
        principal,
        sessionId,
        requestId,
        signal: controller.signal,
        abort: (reason) => controller.abort(reason),
        client: { capabilities, name: this.#clientName(sdk) },
        elicit: this.#elicitFn(sdk, capabilities),
        store: this.#store,
        clock: this.#clock,
        emit: (event) => this.#emit(base, event),
        state,
        reserved,
        clients: { ...this.#clients },
        fetch: globalThis.fetch,
      };
      handlerContexts.set(ctx, this.#handlerContext(sdk, ctx));
      return pipeline(ctx);
    };
  }

  #capabilities(sdk: SdkContextLike): ClientCapabilities {
    if (this._testing.clientCapabilities) return this._testing.clientCapabilities;
    // Capabilities negotiated for the session win. Per-request `_meta`
    // capabilities (stateless 2026-era requests) are only used when there is no
    // session-level value, so a request cannot hide elicitation to weaken approval.
    const caps = this.server.server?.getClientCapabilities?.();
    if (caps && typeof caps === "object") return caps as ClientCapabilities;
    const fromMeta = sdk.mcpReq?._meta?.[CLIENT_CAPABILITIES_META_KEY];
    return (fromMeta && typeof fromMeta === "object" ? fromMeta : {}) as ClientCapabilities;
  }

  #clientName(sdk: SdkContextLike): string | undefined {
    const fromMeta = sdk.mcpReq?._meta?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined;
    if (typeof fromMeta?.name === "string") return fromMeta.name;
    return this.server.server?.getClientVersion?.()?.name;
  }

  #elicitFn(sdk: SdkContextLike, capabilities: ClientCapabilities): CallContext["elicit"] {
    if (this._testing.elicit) return this._testing.elicit;
    if (!capabilities.elicitation) return undefined;
    const v2 = sdk.mcpReq?.elicitInput;
    if (typeof v2 === "function") {
      return async (req) => (await v2({ mode: "form", ...req })) as ElicitResult;
    }
    const v1 = this.server.server?.elicitInput;
    if (typeof v1 === "function") {
      const srv = this.server.server;
      return async (req) => (await v1.call(srv, req)) as ElicitResult;
    }
    return undefined;
  }

  /** The SDK context with Gantry's combined signal and `gantry` attached. */
  #handlerContext(sdk: SdkContextLike, ctx: CallContext): unknown {
    const out: Record<string, unknown> = { ...sdk, gantry: ctx };
    if (sdk.mcpReq) out.mcpReq = { ...sdk.mcpReq, signal: ctx.signal };
    if ("signal" in sdk || !sdk.mcpReq) out.signal = ctx.signal;
    return out;
  }
}

const handlerContexts = new WeakMap<CallContext, unknown>();

/** Reserved values sent in request `_meta` as "gantry/<name>" (for tools whose schema Gantry could not extend). */
function reservedFromMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!meta) return out;
  for (const [key, value] of Object.entries(meta)) {
    if (!key.startsWith("gantry/")) continue;
    if (typeof value === "string" && value.length > 0 && value.length <= 4096) {
      out[`_${key.slice("gantry/".length)}`] = value;
    }
  }
  return out;
}

interface SdkContextLike {
  sessionId?: string;
  signal?: AbortSignal;
  authInfo?: PrincipalRequest["authInfo"];
  _meta?: Record<string, unknown>;
  http?: { authInfo?: PrincipalRequest["authInfo"] };
  mcpReq?: {
    signal?: AbortSignal;
    _meta?: Record<string, unknown>;
    elicitInput?: (params: unknown) => Promise<unknown>;
  };
}

interface RegisteredToolLike {
  handler?: AnyHandler;
  callback?: AnyHandler;
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  update?(updates: { callback: unknown }): void;
}

/** Creates a Gantry pipeline around an `McpServer`. */
export function gantry(server: McpServerLike, options?: GantryOptions): Gantry {
  return new Gantry(server, options);
}

/** `gantry.recommended()` returns the recommended middleware stack. */
gantry.recommended = recommended;
