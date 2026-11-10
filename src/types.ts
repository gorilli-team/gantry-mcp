import type { Clock } from "./clock.js";
import type { Store } from "./store/types.js";

/*
 * Structural MCP types. Gantry does not import types from the SDK so the same
 * build works with `@modelcontextprotocol/server` (v2) and
 * `@modelcontextprotocol/sdk` (v1).
 */

export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface CallToolResult {
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export interface ClientCapabilities {
  elicitation?: Record<string, unknown>;
  sampling?: Record<string, unknown>;
  roots?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ElicitRequest {
  message: string;
  requestedSchema: Record<string, unknown>;
}

export interface ElicitResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/** What Gantry knows about a tool at registration and call time. */
export interface ToolInfo {
  name: string;
  annotations: ToolAnnotations;
  meta: Record<string, unknown>;
}

/** Event emitted on the Gantry event stream. Never contains tokens. */
export interface GantryEvent {
  type: string;
  tool: string;
  principal: string;
  requestId: string;
  sessionId?: string;
  at: number;
  durationMs?: number;
  code?: string;
  [key: string]: unknown;
}

/** The part of an event a module supplies; Gantry fills in the rest. */
export type GantryEventInput = { type: string } & Partial<Omit<GantryEvent, "type">>;

/** The request as seen by the `principal` resolver. */
export interface PrincipalRequest {
  authInfo?: { clientId?: string; [key: string]: unknown };
  sessionId?: string;
  requestId: string;
  tool: string;
  /** Request `_meta`, untrusted (client supplied). */
  meta?: Record<string, unknown>;
  /** The raw context object the SDK passed to the handler. */
  sdk: unknown;
}

export interface CallContext {
  tool: ToolInfo;
  /** Validated input, without Gantry's reserved arguments. */
  args: unknown;
  /** SHA-256 of the RFC 8785 canonical JSON of `args`. */
  argsHash: string;
  principal: string;
  sessionId?: string;
  /** Unique per call (the JSON-RPC id is only unique per session). */
  requestId: string;
  /** Aborted by a timeout or client cancellation. */
  signal: AbortSignal;
  /** Aborts `signal`. Used by `timeout`; handlers can use it too. */
  abort(reason?: unknown): void;
  client: { capabilities: ClientCapabilities; name?: string };
  /** Asks the human through the client. Undefined when the client cannot elicit. */
  elicit?: (req: ElicitRequest) => Promise<ElicitResult>;
  store: Store;
  clock: Clock;
  emit(event: GantryEventInput): void;
  /** Per-call scratch space shared between middlewares. */
  state: Map<string, unknown>;
  /**
   * Values of Gantry's reserved arguments (`_approvalToken`, `_idempotencyKey`),
   * removed from `args`. Client supplied: treat as untrusted.
   */
  reserved: Record<string, unknown>;
  /** Clients registered with `gantry({ clients })`, possibly wrapped by modules. */
  clients: Record<string, unknown>;
  /** `fetch`, possibly wrapped by modules (e.g. annotations enforcement). */
  fetch: typeof fetch;
}

export type Next = () => Promise<CallToolResult>;

export interface MiddlewareHooks {
  /** Name used in errors and docs. */
  gantryName?: string;
  /** Called for every tool Gantry wraps. Throw `GantryConfigError` to refuse registration. */
  onRegister?(tool: ToolInfo): void;
  /** JSON Schemas of reserved arguments this module reads for the given tool. */
  reservedArgs?(tool: ToolInfo): Record<string, Record<string, unknown>>;
  /** Called once when the pipeline is created. */
  init?(api: GantryApi): void;
}

export type Middleware = ((ctx: CallContext, next: Next) => Promise<CallToolResult>) &
  MiddlewareHooks;

/** What a module can reach at init time. */
export interface GantryApi {
  readonly store: Store;
  readonly clock: Clock;
  on(listener: (event: GantryEvent) => void): () => void;
  readonly logger: Logger;
}

export interface Logger {
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}
